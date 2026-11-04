[CmdletBinding()]
param(
    [string]$Root = (Join-Path $env:USERPROFILE '.agent-autoloop-install'),
    [string]$DataDirectory = $env:AGENT_AUTOLOOP_HOME,
    [string]$Repo = $env:AGENT_AUTOLOOP_REPO,
    [ValidateSet('codex', 'claude')][string]$Agent = 'codex',
    [int]$Port = 3350,
    [switch]$NoService
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$utf8 = [System.Text.UTF8Encoding]::new($false)
$utf8Script = [System.Text.UTF8Encoding]::new($true)
function Child-Path([string]$Value, [string]$Parent) {
    $full = [System.IO.Path]::GetFullPath($Value)
    $base = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw "Path is outside its install directory: $full" }
    return $full
}
function Run-Node([string[]]$Arguments) {
    & $node @Arguments
    if ($LASTEXITCODE -ne 0) { throw "agent-autoloop failed: $LASTEXITCODE" }
}
function Write-Owned([string]$File, [string]$Text, [bool]$Script = $false) {
    if ([System.IO.File]::Exists($File) -and -not [System.IO.File]::ReadAllText($File, $utf8).Contains($marker)) { throw "Keeping an existing file owned by another program: $File" }
    $encoding = if ($Script) { $utf8Script } else { $utf8 }
    [System.IO.File]::WriteAllText($File, $Text, $encoding)
}

$Root = [System.IO.Path]::GetFullPath($Root)
if ([string]::IsNullOrWhiteSpace($DataDirectory)) { $DataDirectory = Join-Path $Root 'data' }
$DataDirectory = [System.IO.Path]::GetFullPath($DataDirectory)
if ([string]::IsNullOrWhiteSpace($Repo)) { $Repo = $PSScriptRoot }
$Repo = [System.IO.Path]::GetFullPath($Repo)
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $node --version).Trim()
if ([int](($nodeVersion -replace '^v', '').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
$git = (Get-Command git.exe -ErrorAction Stop).Source
$commit = (& $git -C $Repo rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Repo must be a Git checkout with a committed HEAD.' }
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $id = ([BitConverter]::ToString($hash.ComputeHash($utf8.GetBytes($DataDirectory.ToLowerInvariant())))).Replace('-', '').Substring(0, 16).ToLowerInvariant() } finally { $hash.Dispose() }
$marker = "Agent Autoloop install $id"
$releases = Join-Path $Root 'releases'
$release = Child-Path (Join-Path $releases $commit) $releases
[System.IO.Directory]::CreateDirectory($releases) | Out-Null
if (-not [System.IO.Directory]::Exists($release)) {
    $unique = [Guid]::NewGuid().ToString('N')
    $staging = Child-Path (Join-Path $releases ".staging-$unique") $releases
    $archive = Child-Path (Join-Path $releases ".archive-$unique.zip") $releases
    try {
        & $git -C $Repo archive --format=zip --output $archive HEAD
        if ($LASTEXITCODE -ne 0) { throw 'Could not export the committed source.' }
        Expand-Archive -LiteralPath $archive -DestinationPath $staging
        if (-not (Test-Path -LiteralPath (Join-Path $staging 'worker/windows-job.cs'))) { throw 'This commit does not include native Windows support.' }
        $releaseMetadata = @{ application = 'agent-autoloop'; commit = $commit; id = $id } | ConvertTo-Json
        [System.IO.File]::WriteAllText((Join-Path $staging 'agent-autoloop-release.json'), $releaseMetadata, $utf8)
        $staging = Child-Path $staging $releases
        $release = Child-Path $release $releases
        Move-Item -LiteralPath $staging -Destination $release
    } finally {
        if (Test-Path -LiteralPath $staging) {
            $staging = Child-Path $staging $releases
            if ([System.IO.Path]::GetFileName($staging) -notlike '.staging-*') { throw 'Refusing unexpected recursive cleanup.' }
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    }
}
$releaseMarker = Join-Path $release 'agent-autoloop-release.json'
if (-not (Test-Path -LiteralPath $releaseMarker)) { throw "Keeping an unrecognized release directory: $release" }
$releaseData = [System.IO.File]::ReadAllText($releaseMarker, $utf8) | ConvertFrom-Json
if ($releaseData.application -ne 'agent-autoloop' -or $releaseData.commit -ne $commit -or $releaseData.id -ne $id) { throw 'Release identity does not match this install.' }
$program = Join-Path $release 'bin/agent-autoloop.ts'
$activeFile = Join-Path $Root 'active.json'
if (Test-Path -LiteralPath $activeFile) {
    $old = [System.IO.File]::ReadAllText($activeFile, $utf8) | ConvertFrom-Json
    if ($old.application -ne 'agent-autoloop' -or $old.id -ne $id) { throw 'Keeping an active.json owned by another install.' }
}
$beforeHome = $env:AGENT_AUTOLOOP_HOME
$beforeCommit = $env:AGENT_AUTOLOOP_COMMIT
try {
    $env:AGENT_AUTOLOOP_HOME = $DataDirectory
    $env:AGENT_AUTOLOOP_COMMIT = $commit
    if (-not (Test-Path -LiteralPath (Join-Path $DataDirectory 'config.json'))) {
        Run-Node -Arguments @('--disable-warning=ExperimentalWarning', $program, 'init', '--agent', $Agent, '--no-service', '--port', [string]$Port)
    }
    $bin = Join-Path $Root 'bin'
    [System.IO.Directory]::CreateDirectory($bin) | Out-Null
    $dispatcher = @'
// __MARKER__
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const active=JSON.parse(fs.readFileSync(path.join(__dirname,'../active.json'),'utf8'));
const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning',active.program,...process.argv.slice(2)],{
 env:{...process.env,AGENT_AUTOLOOP_HOME:process.env.AGENT_AUTOLOOP_HOME||active.home,AGENT_AUTOLOOP_COMMIT:active.commit},stdio:'inherit',windowsHide:true
});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
'@
    Write-Owned (Join-Path $bin 'agent-autoloop.cjs') ($dispatcher.Replace('__MARKER__', $marker))
    $cmd = "@echo off`r`nREM $marker`r`nchcp 65001 >nul`r`n`"$node`" `"%~dp0agent-autoloop.cjs`" %*`r`n"
    Write-Owned (Join-Path $bin 'agent-autoloop.cmd') $cmd
    $quotedNode = "'" + $node.Replace("'", "''") + "'"
    $shim = "# $marker`r`n& $quotedNode (Join-Path `$PSScriptRoot 'agent-autoloop.cjs') @args`r`nexit `$LASTEXITCODE`r`n"
    Write-Owned (Join-Path $bin 'agent-autoloop.ps1') $shim $true
    $active = @{ application = 'agent-autoloop'; id = $id; root = $Root; home = $DataDirectory; source = $Repo; commit = $commit; program = $program }
    $json = $active | ConvertTo-Json
    [System.IO.File]::WriteAllText(($activeFile + '.tmp'), $json, $utf8)
    if (Test-Path -LiteralPath $activeFile) { [System.IO.File]::Replace(($activeFile + '.tmp'), $activeFile, (Join-Path $Root 'active.previous.json'), $true) }
    else { [System.IO.File]::Move(($activeFile + '.tmp'), $activeFile) }
    $installationFile = Join-Path $DataDirectory 'installation.json'
    [System.IO.File]::WriteAllText(($installationFile + '.tmp'), $json, $utf8)
    if (Test-Path -LiteralPath $installationFile) { [System.IO.File]::Replace(($installationFile + '.tmp'), $installationFile, (Join-Path $DataDirectory 'installation.previous.json'), $true) }
    else { [System.IO.File]::Move(($installationFile + '.tmp'), $installationFile) }
    if (-not $NoService) { Run-Node -Arguments @('--disable-warning=ExperimentalWarning', $program, 'service', 'install') }
    Run-Node -Arguments @('--disable-warning=ExperimentalWarning', $program, '--version')
    Write-Output "Windows 原生版已安装：$release"
    Write-Output "配置和记录：$DataDirectory"
    Write-Output "命令入口：$bin\agent-autoloop.ps1"
    if ($NoService) { Write-Output '先运行 up 启动中台，再运行 try 完成问答验证。' } else { Write-Output '运行 try 完成问答和续办验证。' }
} finally {
    $env:AGENT_AUTOLOOP_HOME = $beforeHome
    $env:AGENT_AUTOLOOP_COMMIT = $beforeCommit
}
