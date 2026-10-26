import { describe, expect, it } from "vitest";
import { artistKey } from "../../shared/name-noise";
import {
  artistOfChannel,
  featuredInTitle,
  fileNameOf,
  folderArtistsOf,
  namesArtist,
  songKeyOf,
  songOfVideo,
  tidiedFile,
  tidiedSong,
} from "../../shared/song-name";

// A song's artist and title as a player shows them (shared/song-name.ts): how
// downloads are named and tagged, and how Sanitize Filename tidies a folder.
// The names are real ones, from the owner's folder and the videos it came from.

describe("songOfVideo: a download's artist and title", () => {
  type Case = [title: string, channel: string | undefined, artist: string | null, song: string];
  const expectSongs = (cases: Case[]) => {
    for (const [title, channel, artist, song] of cases) {
      expect(songOfVideo(title, channel), `“${title}” by ${channel}`).toEqual({
        artist,
        title: song,
      });
    }
  };

  it("takes the artist the title names, not the channel that uploaded it", () => {
    expectSongs([
      // The artist the title names, not the channel that uploaded it.
      ["ATN - Miss A Day (2004)", "Trance Classics", "ATN", "Miss A Day"],
      [
        "Bomfunk MC's Featuring Max'C - Live Your Life (Push Club Mix) (2002)",
        "Trance Classics",
        "Bomfunk MC's",
        "Live Your Life (Push Club Mix) (feat. Max'C)",
      ],
      [
        "Kendrick Lamar - Money Trees ft. Jay Rock",
        "7clouds",
        "Kendrick Lamar",
        "Money Trees (feat. Jay Rock)",
      ],
      [
        "X-Ecutioners ft. Mike Shinoda, Mr Hahn & Wayne Static - It's Going Down",
        "Tommy Boy",
        "X-Ecutioners",
        "It's Going Down (feat. Mike Shinoda, Mr Hahn & Wayne Static)",
      ],
      // A duo the channel is one of.
      [
        "Ace Ventura & Astrix - Pranava (Volcano On Mars Remix) [4k]",
        "Astrix",
        "Ace Ventura & Astrix",
        "Pranava (Volcano On Mars Remix)",
      ],
    ]);
  });

  it("spells the artist as their own channel does, and finds their name in front, dashed or not", () => {
    expectSongs([
      // The artist's own channel: spelt as it spells itself, unless that's a handle run together.
      ["Dr Dre - Darkside", "Dr. Dre", "Dr. Dre", "Darkside"],
      [
        "Liquid Soul - Devotion (Suduaya remix)",
        "Liquid Soul Official",
        "Liquid Soul",
        "Devotion (Suduaya remix)",
      ],
      ["Jay-Z - 99 Problems", "JayZVEVO", "Jay-Z", "99 Problems"],
      [
        "Michael Jackson - Beat It (Official Video)",
        "michaeljacksonVEVO",
        "Michael Jackson",
        "Beat It",
      ],
      [
        "Mötley Crüe - Kickstart My Heart - Official",
        "Mötley Crüe",
        "Mötley Crüe",
        "Kickstart My Heart",
      ],
      // Its name in front without a dash, or with a dash in it.
      ["Michael Jackson Beat It", "Michael Jackson", "Michael Jackson", "Beat It"],
      ["Static - X - Dead Souls", "Static-X", "Static-X", "Dead Souls"],
      ['Eminem "Lose Yourself"', "EminemMusic", "Eminem", "Lose Yourself"],
    ]);
  });

  it("takes the channel's artist when the title doesn't say who, or says it after the song", () => {
    expectSongs([
      // "Song - Artist", and the album after the song.
      ["Let You Fade - Linkin Park", "Linkin Park", "Linkin Park", "Let You Fade"],
      [
        "Numb (Official Music Video) [4K UPGRADE] - Linkin Park",
        "Linkin Park",
        "Linkin Park",
        "Numb",
      ],
      ["Coeur D'alene - Alter Bridge III", "Alter Bridge", "Alter Bridge", "Coeur D'alene"],
      // A title that doesn't say who, or says only which version it is: the channel's artist.
      ["05 - Miasma", "Ghost", "Ghost", "Miasma"],
      ["The Great Gig In The Sky", "HD Pink Floyd", "Pink Floyd", "The Great Gig In The Sky"],
      ["Shake It Off", "TaylorSwiftVEVO", "Taylor Swift", "Shake It Off"],
      ["Wish You Were Here - 2011 Remaster", "Pink Floyd", "Pink Floyd", "Wish You Were Here"],
      ["Shed So Many Tears - LyricsHQ Version", "2Pac", "2Pac", "Shed So Many Tears"],
      [
        "For All Seasons - Live at the Acropolis",
        "Yanni",
        "Yanni",
        "For All Seasons - Live at the Acropolis",
      ],
      [
        "Out of TimeLyricsHDHQ",
        "Stone Temple Pilots ft. Chester Bennington",
        "Stone Temple Pilots",
        "Out of Time (feat. Chester Bennington)",
      ],
      // YouTube Music's own uploads ("- Topic"): the title is the song, even with a dash in it.
      ["Connections", "Astronaut Ape - Topic", "Astronaut Ape", "Connections"],
      ["Arguru", "deadmau5 - Topic", "deadmau5", "Arguru"],
      ["Quiet Ocean (PS Version)", "Reasonandu - Topic", "Reasonandu", "Quiet Ocean (PS Version)"],
      ["Hit The Floor", "Linkin Park - Topic", "Linkin Park", "Hit The Floor"],
    ]);
  });

  it("without a channel, takes the artist the title names, or nobody", () => {
    expectSongs([
      // In capitals, in title case; without a channel, the title's own artist or nobody.
      [
        "Outkast - DA ART OF STORYTELLIN' featuring SLICK RICK",
        undefined,
        "Outkast",
        "Da Art Of Storytellin' (feat. Slick Rick)",
      ],
      [
        "Kendrick Lamar - Money Trees ft. Jay Rock",
        undefined,
        "Kendrick Lamar",
        "Money Trees (feat. Jay Rock)",
      ],
      ["Numb", undefined, null, "Numb"],
    ]);
  });

  it("doesn't take a song whose name starts with a word of the artist's for the artist", () => {
    expect(songOfVideo("Queen of the Night", "Queen Official")).toEqual({
      artist: "Queen",
      title: "Queen of the Night",
    });
    expect(songOfVideo("Bad Company", "Bad Company")).toEqual({
      artist: "Bad Company",
      title: "Bad Company",
    });
  });

  it("is saved as “Artist - Title”, or the title alone", () => {
    expect(fileNameOf(songOfVideo("Dr Dre - Darkside", "Dr. Dre"))).toBe("Dr. Dre - Darkside");
    expect(fileNameOf({ artist: "AC/DC", title: "Thunderstruck" })).toBe("AC-DC - Thunderstruck");
    expect(fileNameOf({ artist: null, title: "Numb" })).toBe("Numb");
  });
});

describe("artistOfChannel", () => {
  it("is the artist a channel is named after", () => {
    const cases: [string, string][] = [
      ["Linkin Park - Topic", "Linkin Park"],
      ["TaylorSwiftVEVO", "Taylor Swift"],
      ["EminemMusic", "Eminem"],
      ["Queen Official", "Queen"],
      ["Liquid Soul Official", "Liquid Soul"],
      ["AC/DC VEVO", "AC/DC"],
      ["HD Pink Floyd", "Pink Floyd"],
      // Any other channel as it is.
      ["Trance Classics", "Trance Classics"],
      ["7clouds", "7clouds"],
      ["Music", "Music"],
    ];
    for (const [channel, artist] of cases) expect(artistOfChannel(channel)).toBe(artist);
  });
});

describe("namesArtist", () => {
  it("knows a part of a title that names the artist, alone or with others", () => {
    expect(namesArtist("LinkinPark", "Linkin Park")).toBe(true);
    expect(namesArtist("Ace Ventura & Astrix", "Astrix")).toBe(true);
    expect(namesArtist("Stone Temple Pilots ft. Chester Bennington", "Stone Temple Pilots")).toBe(
      true,
    );
    // An album named after the artist, a word inside another.
    expect(namesArtist("Alter Bridge III", "Alter Bridge")).toBe(false);
    expect(namesArtist("Yesterday", "Yes")).toBe(false);
  });
});

describe("featuredInTitle", () => {
  it("writes who's featured as “(feat. …)”", () => {
    const cases: [string, string][] = [
      ["About You feat. blackbear", "About You (feat. blackbear)"],
      ["Mask Off (Remix) ft. Kendrick Lamar", "Mask Off (Remix) (feat. Kendrick Lamar)"],
      ["Ghoom Tana Feat. Ali Noor", "Ghoom Tana (feat. Ali Noor)"],
      ["Natural Born Killaz [feat Ice Cube]", "Natural Born Killaz (feat. Ice Cube)"],
      [
        "Peruvian Cocaine feat Diabolic, Tonedeff, Poison Pen, Loucipher, C-Rayz Wal",
        "Peruvian Cocaine (feat. Diabolic, Tonedeff, Poison Pen, Loucipher, C-Rayz Wal)",
      ],
      // Brackets inside stay as they are.
      ["Lift Off (feat. Chino Moreno [Live])", "Lift Off (feat. Chino Moreno [Live])"],
      // "Left", "Gift": not "ft".
      ["Left Behind", "Left Behind"],
      ["Gift", "Gift"],
    ];
    for (const [title, tidy] of cases) expect(featuredInTitle(title)).toBe(tidy);
  });
});

// Songs from the owner's folder, as they were before Sanitize Filename: [file
// name, title tag, artist tag]. Their artists are what tidiedSong() goes by.
const FOLDER: [name: string, title: string, artist: string | null][] = [
  ["Linkin Park - Burn It Down", "BURN IT DOWN", "Linkin Park"],
  ["Linkin Park - Castle Of Glass", "CASTLE OF GLASS", "Linkin Park"],
  ["Linkin Park - Let You Fade", "Let You Fade - Linkin Park", "Linkin Park"],
  ["Linkin Park - 1stp Klosr", "1Stp Klosr", "LINKIN PARK"],
  ["Linkin park - reading my eyes", "reading my eyes", "Linkin park"],
  ["Hit The Floor - Linkin Park (Meteora)", "Linkin Park (Meteora)", "Hit The Floor"],
  ["Numb - Linkin Park", "Numb - Linkin Park", null],
  ["Fort Minor - 100 Degrees", "100 Degrees", "Fort Minor"],
  ["Fort Minor - Cigarettes", "Cigarettes", "Fort Minor"],
  ["High Road - Fort Minor (feat. John Legend)", "Fort Minor (feat. John Legend)", "High Road"],
  ["Rush - Tom Sawyer", "Tom Sawyer", "Rush"],
  ["Rush - Limelight", "Limelight", "Rush"],
  ["Orion - Rush (Angelic Remix)", "Rush (Angelic Remix)", "Orion"],
  ["ATN - Miss A Day", "ATN - Miss A Day (2004)", "Trance Classics"],
  [
    "Bomfunk MC's Featuring Max'C - Live Your Life (Push Club Mix)",
    "Bomfunk MC's Featuring Max'C - Live Your Life (Push Club Mix) (2002)",
    "Trance Classics",
  ],
  ["Darren Tate - Pulse", "Darren Tate - Pulse (2001)", "Trance Classics"],
  [
    "Gouryella - Tenshi (Transa Remix)",
    "Gouryella - Tenshi (Transa Remix) (2000)",
    "Trance Classics",
  ],
  ["05 About You feat blackbear", "About You (feat. blackbear)", "Mike Shinoda"],
  ["13 I O U", "I.O.U.", "Mike Shinoda"],
  ["Dr Dre - Darkside", "Dr Dre - Darkside", "Dr. Dre"],
  ["Nibana - Soma", "Nibana - Soma (CD1)", "NIBANA"],
  [
    "Alter Bridge - Coeur D'alene - Alter Bridge III",
    "Coeur D'alene - Alter Bridge III",
    "Alter Bridge",
  ],
  ["Alter bridge Metalingus", "Metalingus", "Alter Bridge"],
  ["Ghost - 05 - Miasma", "05 - Miasma", "Ghost"],
  ["Out of TimeLyricsHDHQ", "Out of TimeLyricsHDHQ", "Stone Temple Pilots ft. Chester Bennington"],
  ["Bob Marley - Soul Rebel", "Soul Rebel (Remastered)", "Bob Marley & The Wailers"],
  ["Bob Marley - War", "War", "Bob Marley & The Wailers"],
  ["Bob Marley - Zion TrainHD", "Zion TrainHD", "Bob Marley"],
  [
    "2Pac - Me Against the World (LyricsHQ version)",
    "Me Against the World (LyricsHQ version)",
    "2Pac",
  ],
  ["2Pac - Shed So Many Tears - LyricsHQ Version", "Shed So Many Tears - LyricsHQ Version", "2Pac"],
  ["2pac - Last Ones Left", "Last Ones Left", "2pac"],
  ["Anderson Paak - Might Be", "Might Be", "Anderson .Paak"],
  ["Anderson Paak - Miss Right", "Miss Right", "Anderson .Paak"],
  ["Anderson Paak - Realla", "Realla", "Anderson Paak"],
  ["Ozzy Osborne - Shot in the Dark", "Shot In the Dark", "Ozzy Osbourne"],
  ["Michael Jackson Billie Jean", "Billie Jean", "Michael Jackson"],
  ["Michael Jackson Beat It", "Michael Jackson Beat It", "Michael Jackson"],
  ["Static X Z28", "Z28", "Static-X"],
  [
    "Paul Oakenfold - Requiem For A Dream Remixed - Aeternal",
    "Paul Oakenfold - Requiem For A Dream Remixed - Aeternal",
    null,
  ],
  ["Static - X - Dead Souls", "Dead Souls", "Static-X"],
  ["Transa - Prophase (X-Cabs Remix 1) 0", "Prophase (X-Cabs Remix 1)", "Transa"],
  ["Beethoven - Moonlight Sonata (FULL)", "Moonlight Sonata (FULL)", "Beethoven"],
  ["Linkin Park - With You", "With You", "Linkin Park"],
  ["Queen - Bohemian Rhapsody", "Bohemian Rhapsody", "Queen"],
];
const songs = FOLDER.map(([name, title, artist]) => ({ name, title, artist }));
const folder = folderArtistsOf(songs);
const song = (name: string) => songs.find((each) => each.name === name)!;

describe("folderArtistsOf", () => {
  it("finds the channel that uploaded other people's songs, and no artist", () => {
    expect([...folder.channels]).toEqual([artistKey("Trance Classics")]);
  });

  it("spells each artist as most of its songs do, not in capitals", () => {
    const spelt = (name: string) => folder.artists.get(artistKey(name));
    expect(spelt("Linkin Park")).toEqual({ songs: 6, spelt: "Linkin Park" });
    expect(spelt("2Pac")?.spelt).toBe("2Pac");
    expect(spelt("Anderson Paak")?.spelt).toBe("Anderson .Paak");
  });
});

describe("tidiedFile: Sanitize Filename on the owner's folder", () => {
  // [file name, its file name, artist and title after]
  type Case = [name: string, after: { name: string; artist: string | null; title: string }];
  const expectTidied = (cases: Case[]) => {
    for (const [name, after] of cases) expect(tidiedFile(song(name), folder), name).toEqual(after);
  };

  it("spells titles and artists as the folder does, and an artist's name in the title", () => {
    expectTidied([
      // Titles in capitals, the artist in the title, a misspelt artist: as the folder has them.
      [
        "Linkin Park - Burn It Down",
        { name: "Linkin Park - Burn It Down", artist: "Linkin Park", title: "Burn It Down" },
      ],
      [
        "Linkin Park - Let You Fade",
        { name: "Linkin Park - Let You Fade", artist: "Linkin Park", title: "Let You Fade" },
      ],
      [
        "Linkin Park - 1stp Klosr",
        { name: "Linkin Park - 1stp Klosr", artist: "Linkin Park", title: "1Stp Klosr" },
      ],
      [
        "Linkin park - reading my eyes",
        { name: "Linkin park - reading my eyes", artist: "Linkin Park", title: "reading my eyes" },
      ],
      [
        "2pac - Last Ones Left",
        { name: "2pac - Last Ones Left", artist: "2Pac", title: "Last Ones Left" },
      ],
      [
        "Anderson Paak - Realla",
        { name: "Anderson Paak - Realla", artist: "Anderson .Paak", title: "Realla" },
      ],
      [
        "Ozzy Osborne - Shot in the Dark",
        {
          name: "Ozzy Osbourne - Shot In the Dark",
          artist: "Ozzy Osbourne",
          title: "Shot In the Dark",
        },
      ],
      ["Nibana - Soma", { name: "Nibana - Soma", artist: "Nibana", title: "Soma (CD1)" }],
      ["Dr Dre - Darkside", { name: "Dr Dre - Darkside", artist: "Dr. Dre", title: "Darkside" }],
    ]);
  });

  it("puts round a title and artist the wrong way round, but not a song named like an artist", () => {
    expectTidied([
      // Title and artist the wrong way round; but "Rush (Angelic Remix)" by Orion is a song called Rush.
      [
        "Hit The Floor - Linkin Park (Meteora)",
        { name: "Linkin Park - Hit The Floor", artist: "Linkin Park", title: "Hit The Floor" },
      ],
      [
        "High Road - Fort Minor (feat. John Legend)",
        {
          name: "Fort Minor - High Road (feat. John Legend)",
          artist: "Fort Minor",
          title: "High Road (feat. John Legend)",
        },
      ],
      [
        "Orion - Rush (Angelic Remix)",
        { name: "Orion - Rush (Angelic Remix)", artist: "Orion", title: "Rush (Angelic Remix)" },
      ],
    ]);
  });

  it("gives a channel's uploads the artists their titles name, and moves who's featured into the title", () => {
    expectTidied([
      // A channel's uploads take the artist their titles name.
      ["ATN - Miss A Day", { name: "ATN - Miss A Day", artist: "ATN", title: "Miss A Day" }],
      [
        "Bomfunk MC's Featuring Max'C - Live Your Life (Push Club Mix)",
        {
          name: "Bomfunk MC's Featuring Max'C - Live Your Life (Push Club Mix)",
          artist: "Bomfunk MC's",
          title: "Live Your Life (Push Club Mix) (feat. Max'C)",
        },
      ],
      // Who's featured, from the artist into the title; noise run on to the title.
      [
        "Out of TimeLyricsHDHQ",
        {
          name: "Stone Temple Pilots - Out of Time (feat. Chester Bennington)",
          artist: "Stone Temple Pilots",
          title: "Out of Time (feat. Chester Bennington)",
        },
      ],
      [
        "Bob Marley - Zion TrainHD",
        { name: "Bob Marley - Zion Train", artist: "Bob Marley", title: "Zion Train" },
      ],
      [
        "2Pac - Me Against the World (LyricsHQ version)",
        { name: "2Pac - Me Against the World", artist: "2Pac", title: "Me Against the World" },
      ],
      [
        "2Pac - Shed So Many Tears - LyricsHQ Version",
        { name: "2Pac - Shed So Many Tears", artist: "2Pac", title: "Shed So Many Tears" },
      ],
      [
        "Beethoven - Moonlight Sonata (FULL)",
        { name: "Beethoven - Moonlight Sonata", artist: "Beethoven", title: "Moonlight Sonata" },
      ],
    ]);
  });

  it("takes out what videos add, track numbers and an album after the song", () => {
    expectTidied([
      // Track numbers, an album after the song, the artist without a dash.
      [
        "05 About You feat blackbear",
        {
          name: "Mike Shinoda - About You (feat. blackbear)",
          artist: "Mike Shinoda",
          title: "About You (feat. blackbear)",
        },
      ],
      ["13 I O U", { name: "Mike Shinoda - I.O.U", artist: "Mike Shinoda", title: "I.O.U." }],
      ["Ghost - 05 - Miasma", { name: "Ghost - Miasma", artist: "Ghost", title: "Miasma" }],
      [
        "Alter Bridge - Coeur D'alene - Alter Bridge III",
        { name: "Alter Bridge - Coeur D'alene", artist: "Alter Bridge", title: "Coeur D'alene" },
      ],
      [
        "Alter bridge Metalingus",
        { name: "Alter Bridge - Metalingus", artist: "Alter Bridge", title: "Metalingus" },
      ],
      [
        "Michael Jackson Billie Jean",
        { name: "Michael Jackson - Billie Jean", artist: "Michael Jackson", title: "Billie Jean" },
      ],
      [
        "Michael Jackson Beat It",
        { name: "Michael Jackson - Beat It", artist: "Michael Jackson", title: "Beat It" },
      ],
      ["Static X Z28", { name: "Static-X - Z28", artist: "Static-X", title: "Z28" }],
      // A name with more in it than the song: "Static - X", a stray "0".
      [
        "Static - X - Dead Souls",
        { name: "Static-X - Dead Souls", artist: "Static-X", title: "Dead Souls" },
      ],
      [
        "Transa - Prophase (X-Cabs Remix 1) 0",
        {
          name: "Transa - Prophase (X-Cabs Remix 1)",
          artist: "Transa",
          title: "Prophase (X-Cabs Remix 1)",
        },
      ],
    ]);
  });

  it("names a song without tags from its file name, “Song - Artist” put round when the folder knows the artist", () => {
    expectTidied([
      // Without tags: the artist the name says, "Song - Artist" put round when the folder knows them.
      ["Numb - Linkin Park", { name: "Linkin Park - Numb", artist: "Linkin Park", title: "Numb" }],
      [
        "Paul Oakenfold - Requiem For A Dream Remixed - Aeternal",
        {
          name: "Paul Oakenfold - Requiem For A Dream Remixed - Aeternal",
          artist: "Paul Oakenfold",
          title: "Requiem For A Dream Remixed - Aeternal",
        },
      ],
    ]);
  });

  it("keeps a file name that says the artist and title", () => {
    expectTidied([
      // Its name says its artist ("Bob Marley" for Bob Marley & The Wailers) and title: kept.
      [
        "Bob Marley - Soul Rebel",
        {
          name: "Bob Marley - Soul Rebel",
          artist: "Bob Marley & The Wailers",
          title: "Soul Rebel",
        },
      ],
      [
        "Bob Marley - War",
        { name: "Bob Marley - War", artist: "Bob Marley & The Wailers", title: "War" },
      ],
    ]);
  });

  it("leaves a tidy song as it is", () => {
    for (const name of [
      "Linkin Park - With You",
      "Queen - Bohemian Rhapsody",
      "Fort Minor - Cigarettes",
    ]) {
      const { title, artist } = song(name);
      expect(tidiedFile(song(name), folder)).toEqual({ name, title, artist });
    }
  });

  it("tidies the same without the rest of the folder, only not as the folder spells artists", () => {
    const alone = folderArtistsOf([song("2pac - Last Ones Left")]);
    expect(tidiedSong(song("2pac - Last Ones Left"), alone)).toEqual({
      artist: "2pac",
      title: "Last Ones Left",
    });
    // Without other Linkin Park songs, "Numb - Linkin Park" can't be told from "Artist - Song".
    expect(
      tidiedSong(song("Numb - Linkin Park"), folderArtistsOf([song("Numb - Linkin Park")])),
    ).toEqual({
      artist: "Numb",
      title: "Linkin Park",
    });
  });
});

describe("songKeyOf", () => {
  it("is the same for two copies of a song, whatever their brackets, capitals or spelling", () => {
    expect(songKeyOf({ artist: "Mike Shinoda", title: "About You (feat. blackbear)" })).toBe(
      songKeyOf({ artist: "MIKE SHINODA", title: "About You" }),
    );
    expect(songKeyOf({ artist: "Mötley Crüe", title: "Kickstart My Heart" })).toBe(
      songKeyOf({ artist: "Motley Crue", title: "Kickstart my Heart" }),
    );
    expect(songKeyOf({ artist: "Linkin Park", title: "Numb" })).not.toBe(
      songKeyOf({ artist: "Linkin Park", title: "Faint" }),
    );
  });
});
