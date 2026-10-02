<#
  YouTube Audio Extractor on Windows: what the .cmd files next to this file
  run, so a double-click works whatever PowerShell's script policy is.

    app.ps1 start [-NoBrowser]  Get ready to start the app (start.cmd then runs
                                it): check it isn't running already, install
                                what it needs when needed, and open the
                                browser once it's up.
    app.ps1 stop                Stop the app, however it was started.
    app.ps1 update-yt-dlp       Get the newest yt-dlp (when YouTube downloads
                                stop working).
    app.ps1 autostart-on        Start the app (minimized, no browser) whenever
                                you sign in to Windows.
    app.ps1 autostart-off       Stop starting it with Windows.

  Written for Windows PowerShell 5.1, which every Windows 10 and 11 PC has.
  Keep this file plain ASCII: PowerShell 5.1 reads a script without a
  byte-order mark in the PC's own code page, which garbles anything else.
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "open", "stop", "update-yt-dlp", "autostart-on", "autostart-off")]
  [string] $Action = "start",
  # start: don't open the browser (starting with Windows does this).
  [switch] $NoBrowser,
  # autostart-on/off: the folder Windows starts programs from when you sign in.
  [string] $StartupFolder = [Environment]::GetFolderPath("Startup")
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location -LiteralPath $Root

# npm skips what only development needs when NODE_ENV=production, and the app
# runs with the development server, so make sure it isn't set.
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
# yt-dlp's installer asks for Python, which the Windows yt-dlp.exe doesn't use.
$env:YOUTUBE_DL_SKIP_PYTHON_CHECK = "1"

$AppName = "YouTube Audio Extractor"
$script:ExitCode = 0

# --- Settings ----------------------------------------------------------------

# A setting from this window or the app's .env file (the window wins, as in the app).
function Get-Setting([string] $Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { return $value.Trim() }
  $envFile = Join-Path $Root ".env"
  if (-not (Test-Path -LiteralPath $envFile)) { return $null }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$Name\s*=\s*(.*)$") {
      $value = $Matches[1].Trim()
      if ($value -match '^"(.*)"$' -or $value -match "^'(.*)'$") { return $Matches[1] }
      return ($value -replace '\s+#.*$', '').Trim()
    }
  }
  return $null
}

# Where this computer reaches the app: http://localhost:5000 unless .env says otherwise.
function Get-App {
  $port = Get-Setting "PORT"
  if ($port -notmatch '^\d+$') { $port = "5000" }
  $address = Get-Setting "HOST"
  if (-not $address -or $address -in @("0.0.0.0", "::", "127.0.0.1", "::1", "localhost")) {
    $address = "localhost"
  } elseif ($address.Contains(":")) {
    $address = "[$address]"
  }
  return @{ Port = [int] $port; Url = "http://${address}:$port" }
}

# --- Finding the app ---------------------------------------------------------

function Get-ProcessInfo([int] $Id) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $Id" -ErrorAction SilentlyContinue
}

# The program listening on the app's port, if any.
function Get-PortOwner([int] $Port) {
  $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listening) { Get-ProcessInfo ([int] $listening.OwningProcess) }
}

# The app's server: Node running server/index.ts (npm run dev) or dist/index.cjs (npm start).
function Test-IsServer($proc) {
  return $proc -and $proc.Name -eq "node.exe" -and
    ([string] $proc.CommandLine) -match 'server[\\/]index\.ts|dist[\\/]index\.cjs'
}

# The app's servers: started from this folder, or answering on the app's port.
function Find-Servers([int] $Port) {
  $here = @($Root, $Root.Replace("\", "/"))
  $servers = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
      $commandLine = [string] $_.CommandLine
      (Test-IsServer $_) -and @($here | Where-Object {
          $commandLine.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count -gt 0
    })
  $owner = Get-PortOwner $Port
  if ((Test-IsServer $owner) -and -not ($servers | Where-Object { $_.ProcessId -eq $owner.ProcessId })) {
    $servers += $owner
  }
  return $servers
}

# Part of what started the server - npm, the start.cmd window, Node running
# the dev server - but never the terminal, editor or Explorer it came from.
function Test-IsLauncher($proc) {
  $commandLine = [string] $proc.CommandLine
  if ($proc.Name -eq "node.exe") {
    return $commandLine -match 'server[\\/]index\.ts|dist[\\/]index\.cjs|npm-cli\.js"?\s+(run\s+dev|start)\b'
  }
  if ($proc.Name -in @("cmd.exe", "powershell.exe", "pwsh.exe")) {
    return $commandLine -match 'scripts[\\/]windows[\\/](start\.cmd|app\.ps1)|npm(\.cmd)?"?\s+(run\s+dev|start)\b|cross-env NODE_ENV|server[\\/]index\.ts|dist[\\/]index\.cjs'
  }
  return $false
}

# The process that started a server (stopping it stops everything it started).
function Get-LaunchRoot($proc) {
  $top = $proc
  while ($true) {
    $parent = Get-ProcessInfo ([int] $top.ParentProcessId)
    if (-not $parent -or -not (Test-IsLauncher $parent)) { return $top }
    $top = $parent
  }
}

# Started with a double-click (Explorer, then the .cmd file's window, then this)?
function Test-DoubleClicked {
  $window = Get-ProcessInfo ([int] (Get-ProcessInfo $PID).ParentProcessId)
  if (-not $window -or $window.Name -ne "cmd.exe") { return $false }
  $opener = Get-ProcessInfo ([int] $window.ParentProcessId)
  return $opener -and $opener.Name -eq "explorer.exe"
}

# --- Actions -----------------------------------------------------------------

# Exit codes for start.cmd: 0 = run the app now, 1 = a problem (shown), 2 = already running.
function Start-App {
  $app = Get-App
  if (@(Find-Servers $app.Port).Count -gt 0) {
    Write-Host "$AppName is already running: $($app.Url)"
    if (-not $NoBrowser) { Start-Process $app.Url }
    $script:ExitCode = 2
    return
  }
  $owner = Get-PortOwner $app.Port
  if ($owner) {
    Write-Host "Port $($app.Port) is being used by another program ($($owner.Name), process $($owner.ProcessId))."
    Write-Host "Close that program, or give the app another port: put PORT=5001 in the .env file in $Root"
    $script:ExitCode = 1
    return
  }
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js isn't installed. Install it once with this command, then start the app again:"
    Write-Host "  winget install -e --id OpenJS.NodeJS.LTS"
    $script:ExitCode = 1
    return
  }
  if (Test-NeedsInstall) {
    Write-Host "Installing what the app needs (the first time, or after an update) - this takes a minute or two..."
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) {
      Write-Host "Installing failed (see above)."
      $script:ExitCode = 1
      return
    }
    # Remember this install, so the next start doesn't redo it.
    $installed = Join-Path $Root "node_modules\.package-lock.json"
    if (Test-Path -LiteralPath $installed) { (Get-Item -LiteralPath $installed).LastWriteTime = Get-Date }
  }
  if (-not $NoBrowser) {
    # Opens the browser once the app answers (start.cmd runs the app itself, in its own window).
    Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "open"
    )
  }
  Write-Host ""
  Write-Host "Starting $AppName at $($app.Url)"
  Write-Host "Keep this window open while you use it. Closing it (or running stop.cmd) stops the app."
  Write-Host ""
}

# Packages missing, or package-lock.json changed since they were installed (after a git pull, say).
function Test-NeedsInstall {
  foreach ($file in @("node_modules\.bin\tsx.cmd", "node_modules\youtube-dl-exec\bin\yt-dlp.exe", "node_modules\ffmpeg-static\ffmpeg.exe")) {
    if (-not (Test-Path -LiteralPath (Join-Path $Root $file))) { return $true }
  }
  $installed = Join-Path $Root "node_modules\.package-lock.json"
  $lock = Join-Path $Root "package-lock.json"
  if (-not (Test-Path -LiteralPath $installed)) { return $true }
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  return (Get-Item -LiteralPath $lock).LastWriteTime -gt (Get-Item -LiteralPath $installed).LastWriteTime
}

# (start, behind the scenes) Waits for the app to answer, then opens it in the browser.
function Open-WhenReady {
  $app = Get-App
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -Uri "$($app.Url)/api/settings" -UseBasicParsing -TimeoutSec 5 | Out-Null
      Start-Process $app.Url
      return
    } catch {
      Start-Sleep -Seconds 1
    }
  }
  $script:ExitCode = 1
}

function Stop-App {
  $app = Get-App
  $servers = @(Find-Servers $app.Port)
  if ($servers.Count -eq 0) {
    Write-Host "$AppName isn't running."
    return
  }
  $roots = @{}
  foreach ($server in $servers) {
    $top = Get-LaunchRoot $server
    $roots[[int] $top.ProcessId] = $true
  }
  foreach ($id in @($roots.Keys)) { & taskkill.exe /PID $id /T /F | Out-Null }
  Start-Sleep -Seconds 1
  if (@(Find-Servers $app.Port).Count -gt 0) {
    Write-Host "Couldn't stop $AppName. Close its window instead."
    $script:ExitCode = 1
    return
  }
  Write-Host "$AppName stopped."
}

function Update-YtDlp {
  $exe = Join-Path $Root "node_modules\youtube-dl-exec\bin\yt-dlp.exe"
  if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "yt-dlp isn't installed yet - installing it..."
    & npm.cmd rebuild youtube-dl-exec
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
      Write-Host "Couldn't install yt-dlp (see above)."
      $script:ExitCode = 1
      return
    }
  }
  $before = ([string] (& $exe --version)).Trim()
  Write-Host "yt-dlp $before - looking for a newer version..."
  & $exe -U
  $updateFailed = $LASTEXITCODE -ne 0
  $after = ([string] (& $exe --version)).Trim()
  if ($after -ne $before) {
    Write-Host "Updated yt-dlp from $before to $after."
  } elseif ($updateFailed) {
    Write-Host "Couldn't update yt-dlp (see above). Check the internet connection and try again."
    $script:ExitCode = 1
  } else {
    Write-Host "yt-dlp $after is already the newest version."
  }
}

function Set-Autostart([bool] $On) {
  $link = Join-Path $StartupFolder "$AppName.lnk"
  if (-not $On) {
    if (Test-Path -LiteralPath $link) {
      Remove-Item -LiteralPath $link
      Write-Host "$AppName won't start with Windows any more."
    } else {
      Write-Host "$AppName wasn't set to start with Windows."
    }
    return
  }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($link)
  $shortcut.TargetPath = Join-Path $PSScriptRoot "start.cmd"
  $shortcut.Arguments = "-NoBrowser"
  $shortcut.WorkingDirectory = $Root
  $shortcut.WindowStyle = 7 # minimized
  $shortcut.Description = "Starts $AppName ($((Get-App).Url)) without opening the browser"
  $shortcut.Save()
  Write-Host "$AppName will start (minimized, without opening the browser) whenever you sign in to Windows."
  Write-Host "To stop that, run autostart-off.cmd."
}

switch ($Action) {
  "start" { Start-App }
  "open" { Open-WhenReady }
  "stop" { Stop-App }
  "update-yt-dlp" { Update-YtDlp }
  "autostart-on" { Set-Autostart $true }
  "autostart-off" { Set-Autostart $false }
}

# Started with a double-click: keep the window open to read what happened (start.cmd pauses itself).
if ($Action -notin @("start", "open") -and (Test-DoubleClicked)) {
  Read-Host "Press Enter to close" | Out-Null
}
exit $script:ExitCode
