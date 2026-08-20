<#
.SYNOPSIS
    Sync pi extensions from this repository to the runtime directory.
.DESCRIPTION
    Copies extension files from the repository to $HOME/.pi/agent/extensions/,
    excluding development artifacts (git, node_modules, tests, docs, etc.).
.PARAMETER DryRun
    Preview changes without copying.
.EXAMPLE
    .\sync-extensions.ps1 --DryRun
    Preview what would be synced.
.EXAMPLE
    .\sync-extensions.ps1
    Perform the actual sync.
#>

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$SourceDir = $PSScriptRoot
$TargetDir = Join-Path $HOME '.pi\agent\extensions'
$Usage = 'usage: .\sync-extensions.ps1 [-DryRun]'

function Write-Message {
    param([string]$Message)
    Write-Host $Message
}

function Write-Error-Message {
    param([string]$Message)
    Write-Host "error: $Message" -ForegroundColor Red
    exit 1
}

# Exclusion patterns matching the bash version
$Excludes = @(
    '.git',
    '.githooks',
    '.github',
    'node_modules',
    'package-lock.json',
    '.gitignore',
    '*.md',
    'docs',
    'test',
    '*.test.ts',
    'tsconfig*.json',
    'package.json',
    '*.tsbuildinfo',
    'biome.json',
    'AGENTS.md',
    'sync-extensions.sh',
    'sync-extensions.ps1'
)

function Sync-Extensions {
    param([bool]$DryRun)

    # Build robocopy arguments
    $RobocopyArgs = @(
        $SourceDir,
        $TargetDir,
        '/E',           # Copy subdirectories, including empty ones
        '/IS',          # Include same files
        '/IT',          # Include Tweaked files
        '/NP',          # No progress percentage
        '/NDL'          # No directory list
    )

    if ($DryRun) {
        $RobocopyArgs += '/L', '/NJH', '/NJS'  # List only, no job header, no job summary
        Write-Message "=== DRY RUN: Preview of changes ==="
    } else {
        Write-Message "Syncing extensions to $TargetDir..."
    }

    # Add exclusions - each directory must be a separate /XD argument
    foreach ($exclude in $Excludes) {
        $RobocopyArgs += '/XD', $exclude
    }
    # File exclusions - each pattern must be a separate /XF argument
    $FileExcludes = @('*.md', 'package-lock.json', '.gitignore', '*.test.ts', '*.tsbuildinfo', 'tsconfig*.json', 'biome.json', 'AGENTS.md')
    foreach ($pattern in $FileExcludes) {
        $RobocopyArgs += '/XF', $pattern
    }

    # Ensure target directory exists
    if (-not (Test-Path $TargetDir)) {
        Write-Message "Creating target directory: $TargetDir"
        if (-not $DryRun) {
            New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
        }
    }

    # Run robocopy and capture output
    $robocopyOutput = robocopy @RobocopyArgs 2>&1 | Out-String
    $exitCode = $LASTEXITCODE

    # Show output
    Write-Message $robocopyOutput.Trim()

    # robocopy returns: 0 = no copy needed, 1 = files copied, 2 = extra files, 4+ = errors
    if ($exitCode -ge 8) {
        Write-Error-Message "robocopy failed with exit code: $exitCode"
    }

    return $exitCode
}

function Main {
    Sync-Extensions $DryRun

    if ($DryRun) {
        Write-Message "=== End of dry run ==="
    } else {
        Write-Message "Sync complete. Reload pi with /reload to apply changes."
    }
}

Main
