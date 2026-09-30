# Onboarding for .NET / C# Developers

A guided tour of this codebase for someone whose mental model is .NET Core + C# + Entity Framework + ASP.NET Core. Almost every concept here has a near-direct equivalent in .NET — this doc maps them so you can read the code without first learning a new ecosystem.

If something feels arbitrary, jump to [Why we chose what we chose](#why-we-chose-what-we-chose) at the end.

---

## 1. The 60-second mental model

| .NET / C# concept                     | This stack                                   | Notes                                                                                                                      |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C# language                           | **TypeScript**                               | Strongly typed, but structural ("duck") typing instead of nominal. Compiles to JavaScript.                                 |
| .NET runtime                          | **Node.js**                                  | Single-threaded event loop, async by default.                                                                              |
| .NET CLI (`dotnet`)                   | **npm**                                      | Same idea: install packages, run scripts, build, test.                                                                     |
| `.csproj`                             | **`package.json`**                           | Lists dependencies and runnable scripts.                                                                                   |
| NuGet                                 | **npm registry**                             | `npm install foo` ↔ `dotnet add package Foo`.                                                                              |
| `Program.cs` / `Startup.cs`           | **`server/index.ts`**                        | Entry point, sets up middleware, starts the listener.                                                                      |
| ASP.NET Core controllers              | **`server/routes.ts`**                       | Express routes are the equivalent of attribute-routed controllers.                                                         |
| ASP.NET Core middleware pipeline      | **Express middleware**                       | Same pipeline pattern: `app.use(...)`, request → response.                                                                 |
| Entity Framework Core                 | **Nothing — there's no database**            | The download history is a JSON file. See §5.                                                                               |
| `DbContext` / repository              | **`FileStorage` in `server/storage.ts`**     | Reads and writes `data/history.json`.                                                                                      |
| DTOs / models                         | **`shared/schema.ts`**                       | Zod schemas + inferred TypeScript types — the single source of truth for both sides.                                       |
| FluentValidation / DataAnnotations    | **Zod**                                      | Schema-based runtime validation. Used to validate request bodies in `server/routes.ts`.                                    |
| Razor / Blazor                        | **React + JSX/TSX**                          | Server-rendered HTML at startup, then SPA navigation. Bigger conceptual leap; see §7.                                      |
| Refit + `IMemoryCache` + `HttpClient` | **TanStack Query (`@tanstack/react-query`)** | Typed HTTP fetching with built-in caching, retries, and request deduplication for the frontend.                            |
| `appsettings.json` + environment      | **`.env` file + `process.env`**              | Same idea, simpler. See `.env.example`.                                                                                    |
| `launchSettings.json`                 | **`package.json` "scripts"**                 | `npm run dev` ↔ `dotnet run`.                                                                                              |
| `dotnet build`                        | **`npm run build`**                          | Bundles the client (Vite) and server (esbuild) into `dist/`.                                                               |
| `dotnet run`                          | **`npm run dev`**                            | Dev server with hot reload.                                                                                                |
| xUnit / NUnit                         | **Vitest**                                   | Test runner + assertions. Same `describe / it / expect` shape you know from JS, similar feel to xUnit `[Fact] / [Theory]`. |
| `Microsoft.AspNetCore.Mvc.Testing`    | **Supertest**                                | Spins up your Express app in-process and fires real HTTP requests at it.                                                   |
| Selenium / Playwright .NET            | **Playwright (JS)**                          | Same Playwright, just the JS bindings.                                                                                     |
| StyleCop / .NET analyzers             | **ESLint**                                   | Catches bad patterns at build time. Configured in `eslint.config.js`.                                                      |
| `dotnet format` / EditorConfig        | **Prettier**                                 | Auto-formats source files. Configured in `.prettierrc`.                                                                    |
| Dependency Injection container        | **Module imports + manual wiring**           | Most of the app just `import`s singletons. Only `IStorage` is abstracted — see §4.                                         |
| LINQ                                  | **Array methods**                            | `.map() / .filter() / .reduce()` — LINQ-to-Objects. With no database, that's all the querying there is.                    |
| `async` / `await`                     | **`async` / `await`**                        | Same syntax. C# borrowed this from JavaScript's predecessor and TypeScript inherits it.                                    |

---

## 2. The runtime: Node.js + TypeScript

### What's the same

- TypeScript reads almost like a slimmer C#: `class`, `interface`, `enum`, generics with `<T>`, `async`/`await`, `try`/`catch`, `null`/`undefined` (TS lets you discriminate).
- The compiler (`tsc`) catches type errors before runtime, just like `dotnet build` would.
- We have `strict: true` in `tsconfig.json` — the TypeScript equivalent of treating warnings as errors.

### What's different

- **No CLR.** Node runs JavaScript directly; TypeScript is compiled (or transpiled on the fly by `tsx` in dev) to JS first. There is no IL, no JIT in the .NET sense.
- **Single-threaded event loop.** Everything is async by convention. You won't see threads, locks, or `Task.Run`. Long-running work is offloaded to subprocesses (e.g., we shell out to `yt-dlp` for downloads).
- **Structural typing.** If two types have the same shape, they're compatible. C# uses nominal typing (the type name matters); TS does not. This can feel loose at first but pays off — see how `ThumbnailLike` in `server/youtube-url.ts` lets us test pure helpers without dragging in the full yt-dlp response type.
- **No `null` vs `undefined` unification.** TS treats them as two distinct values. We mostly use `undefined`; `null` shows up at boundaries (e.g., `extractVideoId` returns `string | null`).

---

## 3. Project layout

A typical .NET solution might look like:

```
MySolution.sln
├── MySolution.Api/         (web project)
├── MySolution.Domain/      (business logic, entities)
├── MySolution.Data/        (EF DbContext, migrations)
└── MySolution.Tests/
```

This repo's equivalent:

```
package.json                ← single "project" — the whole repo
client/                     ← React frontend (the equivalent of a Blazor project)
  src/
server/                     ← Express API (the equivalent of Api + Domain + Data)
  index.ts                  ← Program.cs
  routes.ts                 ← Controllers
  storage.ts                ← Repository (IStorage) over a JSON file
  audio.ts                  ← yt-dlp / ffmpeg pipeline arguments
  youtube-url.ts            ← Pure domain helpers
shared/                     ← Code shared by client AND server (no .NET equivalent)
  schema.ts                 ← Zod schema for a history entry
  routes.ts                 ← API contract: paths, methods, request/response shapes
tests/
  unit/                     ← Pure-function tests
  api/                      ← In-process HTTP tests (like WebApplicationFactory)
  browser/                  ← Playwright browser tests
```

The single biggest difference: **`shared/`**. In .NET, sharing types between a web API and a JS client usually means generating TypeScript clients from OpenAPI (NSwag, Refit, etc.). Here, both sides are TypeScript, so they just `import` the same files. `shared/schema.ts` defines the shape of a history entry as a Zod schema, which is both the runtime validator and (via `z.infer`) the TypeScript type. The client and server consume identical types, with zero codegen.

---

## 4. The server: Express vs ASP.NET Core

The mental model is identical: a pipeline of middleware that turns an HTTP request into a response. The syntax is just smaller and less attribute-heavy.

```ts
// server/routes.ts — equivalent of an attribute-routed controller
app.post(api.video.info.path, async (req, res) => {
  const input = api.video.info.input.parse(req.body); // ← Zod validation
  const videoId = extractVideoId(input.url);
  if (!videoId) return res.status(400).json({ message: "Invalid YouTube URL" });
  // ...
});
```

In ASP.NET Core that's:

```csharp
[HttpPost("/api/video/info")]
public IActionResult Info([FromBody] VideoInfoRequest req)
{
    if (!ModelState.IsValid) return BadRequest();
    var videoId = ExtractVideoId(req.Url);
    if (videoId == null) return BadRequest(new { message = "Invalid YouTube URL" });
    // ...
}
```

### The repository pattern is the same

```ts
// server/storage.ts
export interface IStorage {
  getDownloads(): Promise<Download[]>;
  createDownload(download: InsertDownload): Promise<Download>;
}
export class FileStorage implements IStorage {
  /* reads/writes data/history.json */
}
export const storage = new FileStorage();
```

That's exactly the .NET pattern. The difference: we don't run it through a DI container — we just `import { storage } from "./storage"`. For an app this size that's fine. The unit tests simply construct their own `new FileStorage(() => tempFile)`, and a database-backed version would just be another class implementing `IStorage` — the routes wouldn't change.

### No global DI container

This is the most jarring thing for a .NET dev. There's no `IServiceCollection`, no `services.AddScoped<...>()`, no `[Inject]`. Modules export values; consumers `import` them. When you need testability, you depend on an interface (like `IStorage`) and pass implementations explicitly. It's a smaller hammer, and for most Node apps it's enough.

---

## 5. Storage: a JSON file instead of Entity Framework Core

The only thing this app persists is the "Recent Extractions" list: at most 1,000 small entries (about 200 KB), for one user. A database (it used to be Postgres, via Drizzle) meant Docker, a connection string and a schema-push step just to show that list. So it's a JSON file, `data/history.json`, and there's no ORM at all.

### Defining the shape

```ts
// shared/schema.ts
export const downloadSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  downloadedAt: z.string(), // ISO 8601, UTC
});
export type Download = z.infer<typeof downloadSchema>; // ← the "entity"
export type InsertDownload = Pick<Download, "url" | "title">; // ← the create DTO
```

The C# equivalent is a record plus a validator:

```csharp
public record Download(int Id, string Url, string Title, DateTime DownloadedAt);
```

### Reading and writing

```ts
// server/storage.ts (simplified)
async getDownloads() {
  return historySchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}
createDownload(insert) {
  // queued: each write waits for the previous one
  const entries = await readHistory(file);
  await writeHistory(file, [newEntry, ...entries].slice(0, MAX_HISTORY));
}
```

In .NET you'd write roughly:

```csharp
var list = JsonSerializer.Deserialize<List<Download>>(await File.ReadAllTextAsync(path));
await _lock.WaitAsync();                         // SemaphoreSlim(1) ↔ the write queue
try {
    await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(updated));
    File.Move(tmp, path, overwrite: true);       // ↔ write-to-temp + rename
} finally { _lock.Release(); }
```

Two details carry over directly from how you'd do it in .NET:

- **Serialised writes.** Node is single-threaded, but two downloads can still interleave their `await`s (read, read, write, write) and lose an entry. The write queue plays the role of a `SemaphoreSlim(1)`.
- **Atomic replace.** Writing a temp file and renaming it over the old one means a crash never leaves half a JSON file behind.

### When you'd want a database back

If the app ever had several server instances, many users, or needed to search/filter a long history, you'd add a database-backed `IStorage` (SQLite is the natural next step for a single machine — the EF Core equivalent would be the SQLite provider). Only `server/storage.ts` would change.

---

## 6. Validation: Zod vs FluentValidation

`Zod` is the closest thing TS has to FluentValidation. You define a schema once, and you get both a runtime validator AND a static TypeScript type inferred from it.

```ts
// shared/routes.ts
input: z.object({ url: z.string().url() }),

// server/routes.ts — runtime check at the controller boundary
const input = api.video.info.input.parse(req.body);
//                                   ↑ throws ZodError if shape is wrong
```

Equivalent in .NET would be a `FluentValidation` `AbstractValidator<T>` plus a hand-written `T` DTO. With Zod the schema **is** the type — `z.infer<typeof schema>` produces the TypeScript type. No drift between validation rules and the model.

Zod errors are caught in the route handler:

```ts
} catch (err) {
  if (err instanceof z.ZodError) {
    return res.status(400).json({ message: err.errors[0].message, field: err.errors[0].path.join(".") });
  }
  // ...
}
```

---

## 7. The client: React + Vite

This is the section where the analogy with .NET gets weakest. Blazor is the closest thing to React in spirit (component-based UI, data binding), but the mental model is meaningfully different.

### Components

A React component is just a function that returns JSX (HTML-like syntax compiled to JS function calls).

```tsx
function VideoCard({ title, thumbnail }: { title: string; thumbnail: string }) {
  return (
    <div className="card">
      <img src={thumbnail} alt={title} />
      <h3>{title}</h3>
    </div>
  );
}
```

### State

Component-local state lives in `useState` hooks. Hooks are special functions that React tracks for you between renders. You'll see a few of them:

- `useState(initial)` — local mutable state (like a Blazor `[Parameter]` you can write to)
- `useEffect(fn, [deps])` — side effects after render (think `OnAfterRenderAsync`)
- `useQuery({ queryKey, ... })` (TanStack Query) — fetches data and caches it

### The build tool: Vite

Vite is the equivalent of MSBuild for the frontend. In dev, it serves your files instantly (no precompile step) and hot-reloads on save. In prod (`npm run build`), it produces minified JS + CSS bundles in `dist/public/`. The closest .NET analogy is the way Razor's runtime compilation works in dev vs published static assets in prod — same idea, different tools.

We use Vite **as Express middleware** in dev, so the same Node process serves both the API and the dev frontend on port 5000. No CORS, no separate dev server. In prod, Express just serves the pre-built static files from `dist/public/`.

---

## 8. Data fetching on the client

If you've used Refit + `IMemoryCache` + `IHttpClientFactory`, **TanStack Query** does roughly the same job in one library. It:

- Calls your fetch function and types the result
- Caches by `queryKey`
- Deduplicates simultaneous identical requests
- Automatically refetches on window focus / network reconnect (configurable)
- Tracks `isLoading`, `isError`, `data` for you

```tsx
const { data, isLoading } = useQuery<Download[]>({
  queryKey: ["/api/downloads"],
});
```

Mutations (POST/PUT/DELETE) use `useMutation` and you call `queryClient.invalidateQueries({ queryKey: [...] })` to bust the cache after a successful write — that's the manual cache-invalidation pattern, equivalent to clearing a specific `IMemoryCache` entry after an update.

---

## 9. Testing

| Test type   | Tool here              | .NET equivalent                           |
| ----------- | ---------------------- | ----------------------------------------- |
| Unit        | **Vitest**             | xUnit / NUnit                             |
| API in-proc | **Vitest + Supertest** | `WebApplicationFactory<TStartup>` + xUnit |
| Browser e2e | **Playwright**         | Playwright .NET / Selenium                |

### Anatomy of a unit test

```ts
// tests/unit/youtube-url.test.ts
import { describe, it, expect } from "vitest";
import { extractVideoId } from "../../server/youtube-url";

describe("extractVideoId", () => {
  it("parses a standard watch URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe("jNQXAC9IVRw");
  });
});
```

That maps 1:1 onto:

```csharp
public class ExtractVideoIdTests {
    [Fact]
    public void ParsesStandardWatchUrl() {
        Assert.Equal("jNQXAC9IVRw", YouTubeUrl.ExtractVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw"));
    }
}
```

`it.each([...])` is Vitest's table-driven test syntax — the equivalent of `[Theory] + [InlineData]`.

### In-process API tests

`Supertest` boots the Express app in the same Node process and lets you fire HTTP requests at it without a real network call — directly analogous to `WebApplicationFactory<Program>` + `_factory.CreateClient()` in .NET.

```ts
const res = await request(app).post("/api/video/info").send({ url: "..." });
expect(res.status).toBe(200);
```

---

## 10. Tooling

| Job        | Tool                     | .NET equivalent             |
| ---------- | ------------------------ | --------------------------- |
| Type-check | `npx tsc --noEmit`       | `dotnet build`              |
| Lint       | `npx eslint .`           | StyleCop / .NET analyzers   |
| Format     | `npx prettier --write .` | `dotnet format`             |
| Dev server | `npm run dev`            | `dotnet watch run`          |
| Build      | `npm run build`          | `dotnet publish -c Release` |
| Run tests  | `npx vitest run`         | `dotnet test`               |

The `Commands` section of `TECHNICAL.md` has the full list with suggested npm script entries.

---

## 11. Why we chose what we chose

This is the section that actually answers "why didn't you just use X?"

**TypeScript over plain JavaScript.** Catches the bugs you'd catch with C# at compile time. With `strict: true`, the safety net is comparable.

**Express over Fastify / Hono / Koa.** Express 5 is mature, widely understood, and has middleware for everything. The performance difference vs. Fastify isn't relevant for this app's load. Picking the boring option saves onboarding time.

**A JSON file over a database.** The history is one short list for one user. Postgres needed Docker, a connection string and a schema step for that; a file needs nothing. `IStorage` keeps the door open to swap in SQLite later without touching the routes.

**Vite over webpack / Next.js.** Webpack is slow in dev. Next.js would force us to adopt its server model. Vite is just a dev server + a production bundler — the smallest tool that does the job.

**React over Blazor / Vue / Svelte.** React has the largest ecosystem of typed components and the most documentation. shadcn/ui (the component library we use) is React-specific. The trade-off is more boilerplate than Vue/Svelte; the benefit is hireability and ecosystem.

**TanStack Query over `fetch` + manual state.** Hand-rolling cache, retry, dedup, and loading-state logic for every endpoint gets old fast. TanStack Query handles all of that.

**shadcn/ui over Material UI / Chakra.** shadcn isn't an installed package — you copy components into your repo (`client/src/components/ui/`) so you own them. No version-upgrade pain, no vendor lock-in.

**`yt-dlp` (via `youtube-dl-exec`) over pure-JS scrapers like `ytdl-core` / `youtubei.js`.** YouTube actively blocks pure-JS scrapers via PoToken enforcement; `yt-dlp` is the only extractor with a community large enough to keep up. Trade-off: on Linux/macOS it needs Python 3.10+ on the host (on Windows it's a standalone `.exe`).

**No DI container.** For a single-team app with one service implementation per interface, `import` + a singleton is enough. We'd reach for a container if we ever had multiple swappable implementations or a complex object graph.

**Streaming through ffmpeg instead of saving files.** yt-dlp's output is piped into ffmpeg and ffmpeg's output straight into the HTTP response, so nothing is written to disk and the download starts immediately. The cost is that errors after the first byte can only cut the file short — see "Failure modes" in TECHNICAL.md.

---

## 12. TypeScript-isms that look weird from C#

A short field guide to syntax that may stop you on first read:

| You see                         | It means                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `const x: string \| null = ...` | Union type. C# 8+ nullability is the closest thing.                                      |
| `x?.y?.z`                       | Optional chaining. Same as C#'s `x?.y?.z`.                                               |
| `x ?? "default"`                | Null-coalescing. Same as C#'s `??`.                                                      |
| `x as Foo`                      | Type assertion. Like a C# cast but **does not** check at runtime.                        |
| `type Foo = { id: number }`     | Type alias — no runtime existence. C# has no exact analog (closest: a record).           |
| `interface Foo { id: number }`  | Almost identical to C# `interface`, but can describe object shapes (not just contracts). |
| `import { foo } from "./bar"`   | Like `using` + a single import, but file-scoped. There's no `using static` equivalent.   |
| `export default function foo()` | Default export — the file's "main" thing. Importer can rename: `import f from "./foo"`.  |
| `=>`                            | Arrow function. Like a C# lambda but also used to define methods.                        |
| `await Promise.all([a, b, c])`  | Like `Task.WhenAll`.                                                                     |
| `for (const x of arr)`          | `foreach` on an iterable. `for ... in` (without `of`) iterates **keys** — careful.       |
| `[a, b] = [1, 2]`               | Destructuring. Like a tuple deconstruction in C#.                                        |
| `{ a, b }`                      | Object shorthand. `{ a: a, b: b }` — like C# anonymous types with implicit naming.       |

---

## 13. Where to start reading

If you want to trace one full request top-to-bottom, this is the path:

1. **`server/index.ts`** — the entry point (`Program.cs` equivalent). Sets up middleware, registers routes, starts listening.
2. **`shared/routes.ts`** — the API contract. Paths, methods, input/output Zod schemas. Read this once and you'll understand what the API does.
3. **`server/routes.ts`** — the actual handlers. Each one validates input with Zod, calls into `storage` or yt-dlp/ffmpeg (`server/audio.ts`), and returns JSON or streams audio.
4. **`server/storage.ts`** — the repository.
5. **`shared/schema.ts`** — the shape of a history entry.
6. **`client/src/pages/Home.tsx`** — the UI's only page; a good entry point to see how React components, hooks, and TanStack Query fit together.
7. **`client/src/hooks/use-youtube.ts`** — the typed wrappers around `useQuery`/`useMutation` that the UI calls.

That's the whole app.
