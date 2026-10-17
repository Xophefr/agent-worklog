<#
.SYNOPSIS
  Installe (ou réinstalle) la tâche planifiée Windows du relevé de code : l'onglet « Code »
  du tableau de suivi se remplit deux fois par jour, sans y penser.

.DESCRIPTION
  Lance `node scripts/worklog/code-stats.mjs` depuis le clone principal du dépôt (jamais
  depuis un worktree, qui disparaît à la fin de sa session). « Démarrer dès que possible »
  est coché : un poste éteint à l'heure prévue rattrape le relevé au démarrage. Un rejeu le
  même jour remplace le relevé du jour.

  Par défaut la tâche s'appelle CodeStats-<dossier du dépôt>.
  État : Get-ScheduledTaskInfo -TaskName <nom> (LastTaskResult 0 = ok).
  Retrait : Unregister-ScheduledTask -TaskName <nom>

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/worklog/install-code-stats-task.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/worklog/install-code-stats-task.ps1 -At 09:00,18:00
#>
[CmdletBinding()]
param(
    [string]$TaskName = '',
    [string[]]$At = @('08:30', '20:30')
)
$ErrorActionPreference = 'Stop'

$repo = $null
try { $common = (& git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir 2>$null) } catch { $common = $null }
if ($common) { $repo = Split-Path -Parent $common.Trim() }
if (-not $repo) { $repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }   # hors git
$script = Join-Path $repo 'scripts\worklog\code-stats.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "introuvable : $script" }
if (-not $TaskName) { $TaskName = 'CodeStats-' + (Split-Path -Leaf $repo) }

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe introuvable dans le PATH' }

$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $repo
$triggers = $At | ForEach-Object { New-ScheduledTaskTrigger -Daily -At $_ }
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries `
            -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
    -Principal $principal -Force `
    -Description "Relevé de code du tableau de suivi ($repo). Installé par scripts/worklog/install-code-stats-task.ps1." | Out-Null

Write-Host "Tâche $TaskName installée : $($At -join ' et '), $node $script"
