# WorkBuddy Plus Windows read-only diagnostic, review draft 0.1.
# Windows PowerShell 5.1; no external dependencies or configuration writes.
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 3439,
    [ValidateRange(500, 10000)][int]$TimeoutMs = 3000,
    [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'

# Ordered rules. A verified homepage proves reachability at probe time,
# independently of the listener snapshots. The offline Node test reads this table.
$DecisionRules = @'
[
  {"code":"HEALTHY","when":{"tcp":"connected","http":"plus"}},
  {"code":"INCONCLUSIVE","when":{"stable":"no"}},
  {"code":"INCONCLUSIVE","when":{"listener":"unknown"}},
  {"code":"INCONCLUSIVE","when":{"listener":"none","tcp":"connected"}},
  {"code":"PORT_CONFLICT","when":{"listener":"target","owner":"other","tcp":"connected","http":"unexpected"}},
  {"code":"PORT_RESERVED","when":{"listener":"none","reserved":"yes"}},
  {"code":"BACKEND_NOT_LISTENING","when":{"listener":"none"}},
  {"code":"BIND_MISMATCH","when":{"listener":"other","tcp":"refused"}},
  {"code":"INCONCLUSIVE","when":{"listener":"other","tcp":"timeout"}},
  {"code":"TCP_TIMEOUT","when":{"listener":"target","tcp":"timeout"}},
  {"code":"TCP_REFUSED","when":{"listener":"target","tcp":"refused"}},
  {"code":"HTTP_TIMEOUT","when":{"tcp":"connected","http":"timeout"}},
  {"code":"HTTP_UNEXPECTED","when":{"tcp":"connected","http":"unexpected"}},
  {"code":"INCONCLUSIVE","when":{}}
]
'@ | ConvertFrom-Json

function Get-Diagnosis($Facts) {
    foreach ($rule in $DecisionRules) {
        $match = $true
        foreach ($condition in $rule.when.PSObject.Properties) {
            if ($Facts[$condition.Name] -ne $condition.Value) { $match = $false; break }
        }
        if ($match) { return [string]$rule.code }
    }
    return 'INCONCLUSIVE'
}

function Get-ListenerSnapshot([int]$TargetPort) {
    try {
        # Query all listening sockets once; no-match is not a query error.
        $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
            Where-Object { $_.LocalPort -eq $TargetPort })
        return @{ ok = $true; rows = $rows }
    } catch { return @{ ok = $false; rows = @() } }
}

function Get-BindKind([string]$Address) {
    switch ($Address) {
        '127.0.0.1' { return 'loopback-v4' }
        '0.0.0.0'   { return 'wildcard-v4' }
        '::'        { return 'wildcard-v6' }
        '::1'       { return 'loopback-v6' }
        default     { return 'other-address' }
    }
}

function Get-ListenerKind($Snapshot) {
    if (-not $Snapshot.ok) { return 'unknown' }
    if (@($Snapshot.rows | Where-Object { $_.LocalAddress -in @('127.0.0.1','0.0.0.0') }).Count -gt 0) { return 'target' }
    if ($Snapshot.rows.Count -eq 0) { return 'none' }
    if (@($Snapshot.rows | Where-Object { $_.LocalAddress -eq '::' }).Count -gt 0) { return 'unknown' } # dual stack uncertain
    return 'other'
}

function Get-SnapshotKey($Snapshot) {
    if (-not $Snapshot.ok) { return 'unknown' }
    return (@($Snapshot.rows | ForEach-Object { '{0}:{1}' -f $_.LocalAddress, $_.OwningProcess } | Sort-Object) -join '|')
}

function Get-OwnerInfo($Row) {
    $id = [int]$Row.OwningProcess
    $path = $null; $name = $null; $started = $null
    try {
        $p = Get-Process -Id $id -ErrorAction Stop
        $name = [string]$p.ProcessName
        try { $path = [string]$p.Path } catch {}
        try { $started = $p.StartTime.ToUniversalTime().Ticks } catch {}
    } catch {}
    $label = 'unknown'; $kind = 'unknown'
    # Full paths stay in memory only. Unknown filenames are not exported.
    if ($path) {
        $leaf = [IO.Path]::GetFileName($path).ToLowerInvariant()
        if ($leaf -in @('magpie-bun.exe','bun.exe','node.exe','magpie.exe')) {
            $label = $leaf
            if ($leaf -eq 'magpie.exe') { $kind = 'other' } else { $kind = 'runtime' }
        } else { $label = 'other-executable'; $kind = 'other' }
    } elseif ($id -eq 4 -and $name -eq 'System') { $label = 'System'; $kind = 'other' }
    return @{ id = $id; bind = (Get-BindKind $Row.LocalAddress); label = $label; kind = $kind; path = $path; started = $started }
}

function Get-OwnerKind($Owners) {
    $target = @($Owners | Where-Object { $_.bind -in @('loopback-v4','wildcard-v4') })
    if ($target.Count -eq 0) { return 'unknown' }
    if (@($target | Where-Object { $_.kind -ne 'other' }).Count -eq 0) { return 'other' }
    if (@($target | Where-Object { $_.kind -ne 'runtime' }).Count -eq 0) { return 'runtime' }
    return 'unknown'
}

function Get-ReservedPort([int]$TargetPort) {
    try {
        $netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
        $raw = @(& $netsh interface ipv4 show excludedportrange protocol=tcp 2>$null)
        if ($LASTEXITCODE -ne 0) { return 'unknown' }
        $parsed = 0
        foreach ($line in $raw) {
            if ($line -match '^\s*(\d+)\s+(\d+)\s*\*?\s*$') {
                $low = [int]$Matches[1]; $high = [int]$Matches[2]
                if ($low -lt 1 -or $high -gt 65535 -or $low -gt $high) { continue }
                $parsed++
                if ($TargetPort -ge $low -and $TargetPort -le $high) { return 'yes' }
            }
        }
        # Empty or unrecognized output is not proof that a port is available.
        if ($parsed -eq 0) { return 'unknown' }
        return 'no'
    } catch { return 'unknown' }
}

function Get-SocketError($Exception) {
    while ($null -ne $Exception) {
        if ($Exception -is [Net.Sockets.SocketException]) { return [string]$Exception.SocketErrorCode }
        $Exception = $Exception.InnerException
    }
    return 'unknown'
}

function Test-LocalPanel([int]$TargetPort, [int]$WaitMs) {
    $out = @{ tcp = 'unknown'; http = 'not-tested'; status = 0 }
    $client = $null; $pending = $null; $stream = $null; $clock = $null
    try {
        $client = New-Object Net.Sockets.TcpClient -ArgumentList ([Net.Sockets.AddressFamily]::InterNetwork)
        try {
            $pending = $client.BeginConnect([Net.IPAddress]::Loopback, $TargetPort, $null, $null)
            if (-not $pending.AsyncWaitHandle.WaitOne($WaitMs)) { $out.tcp = 'timeout'; return $out }
            $client.EndConnect($pending)
            $out.tcp = 'connected'
        } catch {
            switch (Get-SocketError $_.Exception) {
                'ConnectionRefused' { $out.tcp = 'refused' }
                'TimedOut' { $out.tcp = 'timeout' }
                'AccessDenied' { $out.tcp = 'denied' }
                default { $out.tcp = 'error' }
            }
            return $out
        }
        # Direct IPv4 TCP: no proxy, auth, cookies, redirect, browser, or API calls.
        # HTTP/1.0 + Connection: close; cap data and total read time.
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $stream = $client.GetStream()
        $stream.WriteTimeout = $WaitMs
        $request = [Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.0`r`nHost: 127.0.0.1:$TargetPort`r`nConnection: close`r`nAccept: text/html`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $buf = New-Object byte[] 16384
        $used = 0; $text = ''; $headerEnd = -1
        while ($used -lt $buf.Length) {
            $remaining = $WaitMs - [int]$clock.ElapsedMilliseconds
            if ($remaining -le 0) { $out.http = 'timeout'; return $out }
            $stream.ReadTimeout = [Math]::Max(1, $remaining)
            $n = $stream.Read($buf, $used, $buf.Length - $used)
            if ($n -eq 0) { break }
            $used += $n
            $text = [Text.Encoding]::UTF8.GetString($buf, 0, $used)
            if ($text -match '^HTTP/1\.[01] ([1-5][0-9]{2})(?:\s|$)') { $out.status = [int]$Matches[1] }
            $headerEnd = $text.IndexOf("`r`n`r`n")
            if ($headerEnd -ge 0) {
                if ($out.status -ne 200) { break }
                $body = $text.Substring($headerEnd + 4)
                if ($body.Contains('<title>WorkBuddy Plus</title>') -and $body.Contains('src="/board.js"') -and $body.Contains('src="/app.js"')) {
                    $out.http = 'plus'; return $out
                }
            }
        }
        $out.http = 'unexpected'
    } catch {
        if ($out.tcp -eq 'connected') {
            if ((Get-SocketError $_.Exception) -in @('TimedOut','WouldBlock')) { $out.http = 'timeout' }
            elseif ($null -ne $clock -and $clock.ElapsedMilliseconds -ge $WaitMs) { $out.http = 'timeout' }
            else { $out.http = 'unexpected' }
        }
    } finally {
        if ($null -ne $stream) { try { $stream.Dispose() } catch {} }
        if ($null -ne $client) { try { $client.Close() } catch {} }
        if ($null -ne $pending) { try { $pending.AsyncWaitHandle.Close() } catch {} }
    }
    return $out
}

function Get-PortScope($Filter, [int]$TargetPort) {
    if ([string]$Filter.Protocol -notin @('TCP','6','Any','256')) { return 'none' }
    $unknown = $false; $any = $false
    foreach ($part in @($Filter.LocalPort)) {
        foreach ($item in ([string]$part -split ',')) {
            $v = $item.Trim()
            if ($v -eq 'Any') { $any = $true }
            elseif ($v -match '^\d+$') { if ([int]$v -eq $TargetPort) { return 'specific' } }
            elseif ($v -match '^(\d+)\s*-\s*(\d+)$') { if ($TargetPort -ge [int]$Matches[1] -and $TargetPort -le [int]$Matches[2]) { return 'specific' } }
            else { $unknown = $true }
        }
    }
    if ($any) { return 'any' }
    if ($unknown) { return 'unknown' }
    return 'none'
}

function Get-ProgramPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -eq 'Any') { return '' }
    # Expand only within local memory. No raw rule data is exported.
    try {
        $value = $Path.Trim().Trim('"')
        $allowed = @('SystemRoot','windir','SystemDrive','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','LOCALAPPDATA','APPDATA','USERPROFILE','CommonProgramFiles','CommonProgramFiles(x86)')
        foreach ($m in [regex]::Matches($value, '%([^%]+)%')) {
            $key = $m.Groups[1].Value
            if ($key -notin $allowed) { return '' }
            $replacement = [Environment]::GetEnvironmentVariable($key)
            if (-not $replacement) { return '' }
            $value = $value.Replace($m.Value, $replacement)
        }
        return $value.ToLowerInvariant()
    } catch { return '' }
}

function Get-RuleAction($Rule) {
    if ([string]$Rule.Action -eq 'Allow') { return 'allow' }
    if ([string]$Rule.Action -eq 'Block') { return 'block' }
    return 'unknown'
}

function Test-InboundRule($Rule) {
    return ([string]$Rule.Enabled -eq 'True' -and [string]$Rule.Direction -eq 'Inbound')
}

function Get-FirewallSummary($Owners, [int]$TargetPort) {
    $summary = @{ profiles = @(); state = 'not-checked'; exactAllow = 0; exactBlock = 0; exactUnknown = 0;
        exactOtherPort = 0; otherPath = 0; generalAllow = 0; generalBlock = 0; generalUnknown = 0 }
    try {
        $summary.profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object {
            $name = [string]$_.Name; $enabled = [string]$_.Enabled; $inbound = [string]$_.DefaultInboundAction
            if ($name -notin @('Domain','Private','Public')) { $name = 'Unknown' }
            if ($enabled -notin @('True','False','NotConfigured')) { $enabled = 'Unknown' }
            if ($inbound -notin @('Allow','Block','NotConfigured')) { $inbound = 'Unknown' }
            "$name enabled=$enabled inbound=$inbound"
        })
    } catch { $summary.profiles = @('unavailable') }
    $paths = @($Owners | ForEach-Object { Get-ProgramPath $_.path } | Where-Object { $_ } | Sort-Object -Unique)
    if ($paths.Count -eq 0) { $summary.state = 'no-listener-path'; return $summary }
    $names = @($paths | ForEach-Object { [IO.Path]::GetFileName($_) })
    try {
        $apps = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -ErrorAction Stop)
        foreach ($app in $apps) {
            $program = Get-ProgramPath $app.Program
            if (-not $program) { continue }
            $exact = $program -in $paths
            if (-not $exact -and [IO.Path]::GetFileName($program) -notin $names) { continue }
            foreach ($rule in @($app | Get-NetFirewallRule -ErrorAction Stop)) {
                if (-not (Test-InboundRule $rule)) { continue }
                if (-not $exact) { $summary.otherPath++; continue }
                $filters = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
                if ($filters.Count -ne 1) { $summary.exactUnknown++; continue }
                $scope = Get-PortScope $filters[0] $TargetPort
                if ($scope -eq 'none') { $summary.exactOtherPort++; continue }
                if ($scope -eq 'unknown') { $summary.exactUnknown++; continue }
                switch (Get-RuleAction $rule) {
                    'allow' { $summary.exactAllow++ }
                    'block' { $summary.exactBlock++ }
                    default { $summary.exactUnknown++ }
                }
            }
        }
        # Generic any-program rules explicitly naming this TCP port/range.
        # All-program/all-port, dynamic ports, outbound and WFP rules are out of scope.
        foreach ($filter in @(Get-NetFirewallPortFilter -PolicyStore ActiveStore -ErrorAction Stop)) {
            if ((Get-PortScope $filter $TargetPort) -ne 'specific') { continue }
            foreach ($rule in @($filter | Get-NetFirewallRule -ErrorAction Stop)) {
                if (-not (Test-InboundRule $rule)) { continue }
                $af = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
                if ($af.Count -ne 1) { $summary.generalUnknown++; continue }
                if ([string]$af[0].Program -ne 'Any') { continue }
                switch (Get-RuleAction $rule) {
                    'allow' { $summary.generalAllow++ }
                    'block' { $summary.generalBlock++ }
                    default { $summary.generalUnknown++ }
                }
            }
        }
        $summary.state = 'candidate-scan-complete'
    } catch { $summary.state = 'partial-or-unavailable' }
    return $summary
}

function Format-Report($Facts, $Owners, $Fw, [int]$TargetPort, [int]$WaitMs, [int]$HttpStatus) {
    # Allowlisted values only; never serialize the raw probe, owner or firewall objects.
    $code = Get-Diagnosis $Facts
    '```text'
    'WorkBuddy Plus Windows diagnostic (review draft 0.1)'
    "Port: $TargetPort (127.0.0.1)"
    "Probe timeout per phase (ms): $WaitMs"
    "Diagnosis: $code"
    "Listener: $($Facts.listener); stable snapshot: $($Facts.stable); owner class: $($Facts.owner)"
    "TCP: $($Facts.tcp); HTTP: $($Facts.http); HTTP status: $HttpStatus"
    "IPv4 excluded port: $($Facts.reserved)"
    foreach ($owner in $Owners) {
        $label = 'unknown'; $bind = 'unknown'
        if ($owner.label -in @('magpie-bun.exe','bun.exe','node.exe','magpie.exe','System','other-executable')) { $label = $owner.label }
        if ($owner.bind -in @('loopback-v4','wildcard-v4','wildcard-v6','loopback-v6','other-address')) { $bind = $owner.bind }
        "Listener PID=$([int]$owner.id); bind=$bind; program=$label; path readable=$([bool]$owner.path)"
    }
    "Firewall scan: $($Fw.state)"
    foreach ($profile in $Fw.profiles) { "Firewall profile: $profile" }
    if ($Fw.state -in @('candidate-scan-complete','partial-or-unavailable')) {
        "Inbound exact-program candidates: allow=$($Fw.exactAllow); block=$($Fw.exactBlock); unknown=$($Fw.exactUnknown); other port/protocol=$($Fw.exactOtherPort)"
        "Inbound same filename/different path rules: $($Fw.otherPath)"
        "Inbound any-program/explicit-port candidates: allow=$($Fw.generalAllow); block=$($Fw.generalBlock); unknown=$($Fw.generalUnknown)"
    }
    'Rule counts are candidates, not effective allow/block decisions; profile, address, interface, service, package and remote port scopes not evaluated.'
    'Generic all-port/outbound rules, unresolved paths, third-party filters and WFP are not evaluated.'
    if ($code -eq 'TCP_TIMEOUT') {
        'Hint: listener exists but TCP handshake timed out; review firewall/endpoint security and the actual listening executable. Cause is not confirmed.'
    } elseif ($code -eq 'PORT_CONFLICT') {
        'Hint: a listener outside known Plus runtimes did not return the expected Plus homepage; suspected port conflict. Verify the PID locally before changing the port.'
    } elseif ($code -eq 'PORT_RESERVED') {
        'Hint: target is unbound and lies in an IPv4 excluded range; confirm the configured Plus port.'
    } elseif ($code -eq 'HEALTHY') {
        'Hint: static local panel reachable during the probe; account, scheduler, sidebar and upstream API health not tested.'
        if ($Facts.listener -ne 'target' -or $Facts.stable -ne 'yes') {
            'Listener snapshots did not confirm the listener at the time of the HTTP probe.'
        }
    } elseif ($code -eq 'BACKEND_NOT_LISTENING') {
        'Hint: no listener on this port at both snapshots; verify the configured port and Magpie backend startup.'
    } elseif ($code -eq 'BIND_MISMATCH') {
        'Hint: port is listening only on other addresses; Plus expects IPv4 loopback.'
    } elseif ($code -eq 'HTTP_UNEXPECTED') {
        'Hint: TCP works but expected Plus homepage marker was not seen; possible other service or HTTP error.'
    } else { 'Hint: inspect the reported facts; no automatic repair was attempted.' }
    'No account/config/log contents, command lines, full paths, rule names, or non-loopback addresses included.'
    '```'
}

function Invoke-SelfTest {
    # Pure fixture tests. No socket, firewall, process or user file access.
    $base = @{ stable='yes'; listener='target'; owner='runtime'; tcp='connected'; http='plus'; reserved='no' }
    $cases = @(
        @{ code='HEALTHY'; change=@{} },
        @{ code='HEALTHY'; change=@{stable='no'; listener='unknown'; owner='unknown'} },
        @{ code='HEALTHY'; change=@{stable='no'} },
        @{ code='HEALTHY'; change=@{owner='other'} },
        @{ code='BACKEND_NOT_LISTENING'; change=@{listener='none'; tcp='refused'; http='not-tested'; owner='unknown'} },
        @{ code='PORT_RESERVED'; change=@{listener='none'; tcp='refused'; http='not-tested'; owner='unknown'; reserved='yes'} },
        @{ code='PORT_CONFLICT'; change=@{owner='other'; http='unexpected'} },
        @{ code='INCONCLUSIVE'; change=@{owner='other'; http='not-tested'} },
        @{ code='TCP_TIMEOUT'; change=@{owner='other'; tcp='timeout'; http='not-tested'} },
        @{ code='HTTP_TIMEOUT'; change=@{owner='other'; http='timeout'} },
        @{ code='TCP_TIMEOUT'; change=@{tcp='timeout'; http='not-tested'} },
        @{ code='TCP_REFUSED'; change=@{tcp='refused'; http='not-tested'} },
        @{ code='HTTP_TIMEOUT'; change=@{http='timeout'} },
        @{ code='HTTP_UNEXPECTED'; change=@{http='unexpected'} },
        @{ code='INCONCLUSIVE'; change=@{stable='no'; listener='unknown'; tcp='refused'; http='not-tested'} },
        @{ code='INCONCLUSIVE'; change=@{stable='no'; http='unexpected'} },
        @{ code='BIND_MISMATCH'; change=@{listener='other'; tcp='refused'; http='not-tested'} },
        @{ code='INCONCLUSIVE'; change=@{listener='none'; tcp='connected'; http='unexpected'} },
        @{ code='HEALTHY'; change=@{listener='none'; owner='unknown'} },
        @{ code='TCP_TIMEOUT'; change=@{tcp='timeout'; http='not-tested'; reserved='yes'} }
    )
    foreach ($case in $cases) {
        $f = $base.Clone(); foreach ($k in $case.change.Keys) { $f[$k] = $case.change[$k] }
        if ((Get-Diagnosis $f) -ne $case.code) { throw "Self-test failed: $($case.code)" }
    }
    $owner = @{ id=1234; bind='loopback-v4'; label='magpie-bun.exe'; path='C:\Users\PRIVATE_USER\secret\magpie-bun.exe'; started=123 }
    $fw = @{ state='candidate-scan-complete'; profiles=@('Public enabled=True inbound=Block'); exactAllow=0; exactBlock=1; exactUnknown=0; exactOtherPort=0; otherPath=1; generalAllow=0; generalBlock=0; generalUnknown=0; raw='PRIVATE_TOKEN' }
    $report = (Format-Report $base @($owner) $fw 3439 3000 200) -join "`n"
    if ($report -match 'PRIVATE_USER|PRIVATE_TOKEN|C:\\Users' -or $report -notmatch 'program=magpie-bun.exe' -or $report -notmatch 'block=1') { throw 'Self-test failed: redaction' }
    if ((Get-PortScope @{Protocol='TCP';LocalPort=@('3430-3440')} 3439) -ne 'specific' -or (Get-PortScope @{Protocol='UDP';LocalPort='3439'} 3439) -ne 'none' -or (Get-PortScope @{Protocol='TCP';LocalPort='Any'} 3439) -ne 'any') { throw 'Self-test failed: port filter' }
    'PASS: {0} classification fixtures, redaction and port-filter fixtures.' -f $cases.Count
}

if ($SelfTest) { Invoke-SelfTest; return }
if ($env:OS -ne 'Windows_NT') { throw 'Run this diagnostic on Windows, or use -SelfTest.' }

try {
    $first = Get-ListenerSnapshot $Port
    $owners = @($first.rows | ForEach-Object { Get-OwnerInfo $_ })
    $ownerKind = Get-OwnerKind $owners
    $probe = Test-LocalPanel $Port $TimeoutMs
    $second = Get-ListenerSnapshot $Port
    $stable = 'no'
    if ($first.ok -and $second.ok -and (Get-SnapshotKey $first) -eq (Get-SnapshotKey $second)) {
        $stable = 'yes'
        foreach ($owner in $owners) {
            if ($null -ne $owner.started) {
                try { if ((Get-Process -Id $owner.id -ErrorAction Stop).StartTime.ToUniversalTime().Ticks -ne $owner.started) { $stable = 'no' } }
                catch { $stable = 'no' }
            }
        }
    }
    $facts = @{ stable=$stable; listener=(Get-ListenerKind $first); owner=$ownerKind; tcp=$probe.tcp; http=$probe.http; reserved=(Get-ReservedPort $Port) }
    $fw = Get-FirewallSummary $owners $Port
    Format-Report $facts $owners $fw $Port $TimeoutMs $probe.status
} catch {
    '```text'
    'WorkBuddy Plus Windows diagnostic (review draft 0.1)'
    "Port: $Port (127.0.0.1)"
    'Diagnosis: INCONCLUSIVE'
    'An unexpected diagnostic error occurred; raw error details withheld for privacy.'
    'No automatic repair was attempted.'
    '```'
}
