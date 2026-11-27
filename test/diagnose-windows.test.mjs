// Offline decision-table contract test. No Windows APIs or sockets.
// This exercises the exact table embedded in the PowerShell draft, NOT the
// PowerShell interpreter or Windows collectors. Run -SelfTest on Windows too.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = readFileSync(new URL('../scripts/diagnose-windows.ps1', import.meta.url), 'utf8');
const table = JSON.parse(source.match(/\$DecisionRules = @'\r?\n([\s\S]+?)\r?\n'@ \| ConvertFrom-Json/)[1]);
const base = { stable:'yes', listener:'target', owner:'runtime', tcp:'connected', http:'plus', reserved:'no' };
const diagnose = changes => {
  const facts = { ...base, ...changes };
  return table.find(rule => Object.entries(rule.when).every(([key, value]) => facts[key] === value)).code;
};
const cases = [
  ['normal Plus static page', {}, 'HEALTHY'],
  ['verified Plus page with unavailable listener information', {stable:'no',listener:'unknown',owner:'unknown'}, 'HEALTHY'],
  ['verified Plus page despite a listener change', {stable:'no'}, 'HEALTHY'],
  ['Issue 22: runtime listener, handshake timeout, missing allow rule not assumed causal', {tcp:'timeout',http:'not-tested'}, 'TCP_TIMEOUT'],
  ['listener with excluded range still times out', {tcp:'timeout',http:'not-tested',reserved:'yes'}, 'TCP_TIMEOUT'],
  ['backend absent', {listener:'none',owner:'unknown',tcp:'refused',http:'not-tested'}, 'BACKEND_NOT_LISTENING'],
  ['backend absent, reservation known', {listener:'none',owner:'unknown',tcp:'refused',http:'not-tested',reserved:'yes'}, 'PORT_RESERVED'],
  ['backend absent, reservation query inaccessible', {listener:'none',owner:'unknown',tcp:'refused',http:'not-tested',reserved:'unknown'}, 'BACKEND_NOT_LISTENING'],
  ['known non-runtime listener without the Plus homepage', {owner:'other',http:'unexpected'}, 'PORT_CONFLICT'],
  ['known non-runtime listener with no HTTP evidence', {owner:'other',http:'not-tested'}, 'INCONCLUSIVE'],
  ['known non-runtime listener with a TCP timeout', {owner:'other',tcp:'timeout',http:'not-tested'}, 'TCP_TIMEOUT'],
  ['known non-runtime listener with an HTTP timeout', {owner:'other',http:'timeout'}, 'HTTP_TIMEOUT'],
  ['Node or Bun serving something else (shared runtime)', {http:'unexpected'}, 'HTTP_UNEXPECTED'],
  ['unknown executable, TCP refused', {owner:'unknown',tcp:'refused',http:'not-tested'}, 'TCP_REFUSED'],
  ['TCP succeeds, HTTP times out', {http:'timeout'}, 'HTTP_TIMEOUT'],
  ['TCP succeeds, HTTP error or no identity marker', {http:'unexpected'}, 'HTTP_UNEXPECTED'],
  ['access denied during TCP handshake', {tcp:'denied',http:'not-tested'}, 'INCONCLUSIVE'],
  ['listener query failed and no Plus page was verified', {stable:'no',listener:'unknown',tcp:'refused',http:'not-tested'}, 'INCONCLUSIVE'],
  ['IPv6-only wildcard ambiguity', {listener:'unknown',tcp:'refused',http:'not-tested'}, 'INCONCLUSIVE'],
  ['listener changed or PID was reused and no Plus page was verified', {stable:'no',http:'unexpected'}, 'INCONCLUSIVE'],
  ['known other bind address and refused IPv4 loopback', {listener:'other',owner:'unknown',tcp:'refused',http:'not-tested'}, 'BIND_MISMATCH'],
  ['other bind address and loopback timeout', {listener:'other',owner:'unknown',tcp:'timeout',http:'not-tested'}, 'INCONCLUSIVE'],
  ['both snapshots empty but TCP succeeded', {listener:'none',owner:'unknown',http:'unexpected'}, 'INCONCLUSIVE'],
  ['both snapshots empty but Plus page verified during the probe', {listener:'none',owner:'unknown'}, 'HEALTHY'],
  ['readable static panel even if process path is unavailable', {owner:'unknown'}, 'HEALTHY'],
  ['known non-runtime listener returning a verified Plus page', {owner:'other'}, 'HEALTHY'],
];
for (const [name, facts, expected] of cases) test(name, () => assert.equal(diagnose(facts), expected));
test('the diagnostic probes HTTP regardless of the discovered executable', () => {
  assert.match(source, /^[ \t]*\$probe = Test-LocalPanel \$Port \$TimeoutMs[ \t]*\r?$/m);
  assert.doesNotMatch(source, /\$SkipHttp\b/);
});
test('decision table has a final catch-all, known facts only', () => {
  assert.deepEqual(table.at(-1), { code:'INCONCLUSIVE', when:{} });
  for (const row of table) for (const k of Object.keys(row.when)) assert.ok(k in base);
});
test('read-only static source guard (not runtime verification)', () => {
  assert.match(source, /GET \/ HTTP\/1\.0/);
  assert.match(source, /\[Net\.IPAddress\]::Loopback/);
  assert.doesNotMatch(source, /\/api\/|\b(?:New|Set|Remove|Enable|Disable)-NetFirewall\w*\b|\b(?:Stop-Process|Start-Process|Start-Job|Start-ScheduledTask|Set-ExecutionPolicy|Invoke-Expression|Get-Content|Get-CimInstance|Get-WmiObject|Invoke-WebRequest|Invoke-RestMethod|Set-Content|Out-File)\b|plugin-auth\.json|\.CommandLine\b/);
});
test('report formatter never interpolates raw executable path or raw rule objects', () => {
  const formatter = source.split('function Format-Report(')[1].split('function Invoke-SelfTest')[0];
  assert.match(formatter, /\[bool\]\$owner\.path/);
  assert.doesNotMatch(formatter, /ConvertTo-Json|\$\(\$owner\.path\)|\$rule\.|\$app\.|\$filter\./);
  assert.match(formatter, /other-executable/);
});
