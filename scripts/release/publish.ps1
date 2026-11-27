# Run from a normal PowerShell session with GitHub push access.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-ReleaseGit {
    & git @args
    if ($LASTEXITCODE -ne 0) { throw "Git command failed: git $args" }
}

Push-Location (Join-Path $PSScriptRoot '../..')
try {
    if ((git branch --show-current) -ne 'main') { throw 'Switch to main before publishing.' }
    git diff --cached --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Commit or unstage existing staged changes first.' }

    $repository = 'https://github.com/liulewis67-ops/StarAt.git'
    $remote = git config --get remote.origin.url
    if ($LASTEXITCODE -ne 0) {
        Invoke-ReleaseGit remote add origin $repository
    } elseif ($remote -notin @($repository, 'git@github.com:liulewis67-ops/StarAt.git')) {
        throw "Unexpected origin: $remote"
    }

    $releasePaths = @(
        '.github/workflows/release.yml', '.github/workflows/pages.yml',
        'README.md', 'CHANGELOG.md',
        'apps/desktop/src-tauri/tauri.conf.json',
        'apps/landing/index.html', 'apps/landing/landing.js', 'apps/landing/README.md',
        'docs/development/release.md', 'docs/development/releases/v0.1.0.md',
        'scripts/release/publish.ps1'
    )
    Invoke-ReleaseGit diff --check
    Invoke-ReleaseGit add -- @releasePaths
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
        Invoke-ReleaseGit commit -m 'chore: prepare v0.1.0 release and GitHub Pages'
    } elseif ($LASTEXITCODE -ne 0) {
        throw 'Could not inspect staged changes.'
    }

    $head = git rev-parse HEAD
    git show-ref --verify --quiet refs/tags/v0.1.0
    $tagExists = $LASTEXITCODE -eq 0
    $tagHead = if ($tagExists) { git rev-parse 'refs/tags/v0.1.0^{commit}' } else { $null }
    if ($tagExists -and $tagHead -ne $head) {
        throw 'v0.1.0 already points to a different commit. No tag was moved.'
    }

    Invoke-ReleaseGit push -u origin main
    if (-not $tagExists) { Invoke-ReleaseGit tag -a v0.1.0 -m 'StarAt 0.1.0' }
    Invoke-ReleaseGit push origin v0.1.0
    Write-Host 'Pushed main and v0.1.0. Check Release and Deploy landing page in GitHub Actions.'
    Write-Host 'First deployment: set Settings > Pages > Source to GitHub Actions, then rerun Deploy landing page if needed.'
} finally {
    Pop-Location
}
