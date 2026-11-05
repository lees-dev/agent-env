# rules+skills verify drop-in (Windows). Dot-sourced by scripts/verify.ps1: never exits.
# Read-only. Prints counts and skill names, never file contents.
# Uses $Repo and $Harnesses from scripts/verify.ps1, and the Ae-* helpers.

$skNames = @(Get-ChildItem -LiteralPath (Join-Path $Repo 'home\dot_agents\skills') -Directory -Filter 'exact_*' | ForEach-Object { $_.Name.Substring(6) } | Sort-Object)
$skAgents = Join-Path $HOME '.agents\skills'
$skClaude = Join-Path $HOME '.claude\skills'

# 1. The canonical copies are deployed.
$skBad = @($skNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $skAgents $_) 'SKILL.md')) })
if ($skBad.Count -eq 0) { Ae-Ok ('' + $skNames.Count + ' canonical skills in ~/.agents/skills') }
else { Ae-Fail ('canonical skills missing from ~/.agents/skills: ' + ($skBad -join ' ')); Ae-Hint 'scripts/backup.ps1, then chezmoi apply --force --no-tty' }

# 2. ~/.claude/skills/<name> is a junction to the canonical copy.
if ($Harnesses -contains 'claude') {
    $skOk = 0; $skMissing = @(); $skReal = @(); $skWrong = @()
    foreach ($skN in $skNames) {
        $skP = Join-Path $skClaude $skN
        $skItem = Get-Item -LiteralPath $skP -Force -ErrorAction SilentlyContinue
        if (-not $skItem) { $skMissing += $skN; continue }
        if ($skItem.LinkType -eq 'Junction' -or $skItem.LinkType -eq 'SymbolicLink') {
            $skT = @($skItem.Target)[0]
            $skWant = [IO.Path]::GetFullPath((Join-Path $skAgents $skN)).TrimEnd('\')
            if ($skT -and ([IO.Path]::GetFullPath($skT).TrimEnd('\') -ieq $skWant) -and (Test-Path -LiteralPath $skWant)) { $skOk++ } else { $skWrong += $skN }
        } else { $skReal += $skN }
    }
    if ($skOk -eq $skNames.Count) { Ae-Ok ('' + $skOk + '/' + $skNames.Count + ' ~/.claude/skills entries are junctions to ~/.agents/skills') }
    if ($skMissing.Count -gt 0) { Ae-Fail ('no junction in ~/.claude/skills for: ' + ($skMissing -join ' ')); Ae-Hint 'chezmoi apply (run_after_20-skills-links makes them)' }
    if ($skWrong.Count -gt 0) { Ae-Fail ('link points elsewhere or dangles: ' + ($skWrong -join ' ')); Ae-Hint 'chezmoi apply (the link script records and replaces it)' }
    if ($skReal.Count -gt 0) {
        Ae-Fail ('real copy differs from the canonical skill, left in place: ' + ($skReal -join ' '))
        Ae-Hint 'compare it with ~/.agents/skills/<name>; move wanted changes into the agent-env repo, delete the copy, then chezmoi apply'
    }
    if (Test-Path -LiteralPath (Join-Path $skClaude 'synced')) { Ae-Info '~/.claude/skills/synced is app-managed and left alone' }
} else {
    Ae-Info 'claude not selected: no ~/.claude/skills links expected'
}

# 3. Dangling junctions or symlinks directly in the skill roots.
$skDang = 0
foreach ($skRoot in @($skClaude, $skAgents)) {
    if (-not (Test-Path -LiteralPath $skRoot)) { continue }
    foreach ($skI in (Get-ChildItem -LiteralPath $skRoot -Force -Directory -ErrorAction SilentlyContinue)) {
        if ($skI.LinkType -ne 'Junction' -and $skI.LinkType -ne 'SymbolicLink') { continue }
        $skT = @($skI.Target)[0]
        if (-not $skT -or -not (Test-Path -LiteralPath $skT)) { $skDang++ }
    }
}
if ($skDang -eq 0) { Ae-Ok 'no dangling links in ~/.claude/skills or ~/.agents/skills' }
else { Ae-Warn ('' + $skDang + ' dangling links in ~/.claude/skills or ~/.agents/skills') }

# 4. Rules files carry the managed header (content parity is chezmoi verify's job).
foreach ($skH in @('claude', 'codex', 'grok')) {
    if ($Harnesses -notcontains $skH) { continue }
    if ($skH -eq 'claude') { $skF = Join-Path $HOME '.claude\CLAUDE.md' } else { $skF = Join-Path $HOME ('.' + $skH + '\AGENTS.md') }
    if ((Test-Path -LiteralPath $skF) -and (Select-String -LiteralPath $skF -SimpleMatch 'Managed by agent-env' -Quiet)) { Ae-Ok ($skH + ' global rules are the agent-env copy') }
    else { Ae-Fail ($skH + ' global rules are not the agent-env copy'); Ae-Hint 'scripts/backup.ps1, then chezmoi apply --force --no-tty' }
}
if ($Harnesses -contains 'grok') {
    # Tested on Grok 1.0.70 with a throwaway home (2026-11-04): neither [compat.claude] agents = false
    # nor rules = false stops it loading ~/.claude/CLAUDE.md, so there is nothing to set (docs/skills.md).
    Ae-Info 'grok also loads ~/.claude/CLAUDE.md (no working switch in 1.0.70; docs/skills.md)'
}
if ($Harnesses -contains 'muse') { Ae-Info 'muse: rules come from a one-time /rules import (docs/skills.md); rerun it after the rules change' }

# 5. The retired hand sync must not rewrite the managed files.
if (Test-Path -LiteralPath (Join-Path $HOME 'bin\sync-agent-standards')) {
    Ae-Warn '~/bin/sync-agent-standards still exists; chezmoi now owns the rules files'
    Ae-Hint 'retire it (move it to ~/.agent-env-backups) so it cannot rewrite the standards block'
}

# 6. The backup list names every exact_ skill directory (apply --force deletes whatever the
#    repo lacks in it) and every link the script may replace.
$skList = Join-Path $Repo 'scripts\backup.d\20-skills.list'
$skHave = @()
if (Test-Path -LiteralPath $skList) { $skHave = @(Get-Content -LiteralPath $skList | ForEach-Object { ($_ -replace '#.*$', '').Trim() } | Where-Object { $_ } | Sort-Object) }
$skWant = @($skNames | ForEach-Object { '.agents/skills/' + $_; '.claude/skills/' + $_ } | Sort-Object)
if (($skHave -join ' ') -ne ($skWant -join ' ')) { Ae-Warn 'scripts/backup.d/20-skills.list does not match the skill list (repo fix)' }

Remove-Variable -Name skNames, skAgents, skClaude, skBad, skOk, skMissing, skReal, skWrong, skDang, skList, skHave, skWant, skGc, skOff, skSec, skF, skH, skN, skP, skItem, skT, skI, skRoot, skLine -ErrorAction SilentlyContinue
