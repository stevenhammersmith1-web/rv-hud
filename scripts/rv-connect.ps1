<#
  rv-connect.ps1 - put this laptop on the sniffer's WiFi while keeping internet.

    .\scripts\rv-connect.ps1           # join RV-HUD-SNIFF and verify everything
    .\scripts\rv-connect.ps1 -Revert   # go back to the house WiFi

  WHY THIS EXISTS
  The ESP32 bridge is powered from the buck converter off J1939 pin B, and USB
  must never be plugged in at the same time (two supplies on one 5 V rail), so
  the serial console is not available at the coach. The sniffer serves the same
  diagnostic over its own WiFi AP instead.

  But the laptop has ONE WiFi radio. Joining RV-HUD-SNIFF means leaving the
  house network, and that AP has no internet. So internet has to arrive over
  something else - Bluetooth tethering from the phone (or USB tethering).

  Requires rv_hud_wifi_sniffer.ino built with OFFER_GATEWAY_DNS 0, which makes
  the AP hand out an address only. If it offers a gateway and DNS, Windows
  routes the internet at the ESP32 and resolves every hostname to 192.168.4.1.
#>
param(
  [switch]$Revert,
  [string]$HomeSsid  = "Hammer",
  [string]$SnifferSsid = "RV-HUD-SNIFF"
)

function Show-Wifi { (netsh wlan show interfaces | Select-String 'SSID\s+:|State\s+:') -join "`n" }

if ($Revert) {
  Write-Host "Reconnecting to $HomeSsid ..." -ForegroundColor Cyan
  netsh wlan connect name=$HomeSsid interface="Wi-Fi" | Out-Null
  Start-Sleep 6
  Show-Wifi
  return
}

Write-Host "== checking the tether (internet must not come over WiFi) ==" -ForegroundColor Cyan
$bt = Get-NetAdapter -Name 'Bluetooth Network Connection' -ErrorAction SilentlyContinue
$usb = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'NDIS|Tether' -and $_.Status -eq 'Up' }
if (($bt -and $bt.Status -eq 'Up') -or $usb) {
  if ($bt -and $bt.Status -eq 'Up') { Write-Host "  Bluetooth PAN is up" -ForegroundColor Green }
  if ($usb) { Write-Host "  USB tether is up: $($usb.Name)" -ForegroundColor Green }
} else {
  Write-Host "  NO TETHER FOUND." -ForegroundColor Red
  Write-Host "  Turn on Bluetooth tethering on the phone, then in Windows:"
  Write-Host "  Settings > Bluetooth & devices > Pixel 9a > Personal Area Network > Join"
  Write-Host "  Continuing anyway - you will lose internet once WiFi switches."
}

Write-Host "== joining $SnifferSsid ==" -ForegroundColor Cyan
netsh wlan connect name=$SnifferSsid ssid=$SnifferSsid interface="Wi-Fi" | Out-Null
$got = $false
for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep 1
  if (Get-NetIPAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like '192.168.4.*' }) { $got = $true; break }
}
if (-not $got) { Write-Host "  never got a 192.168.4.x lease" -ForegroundColor Red; Show-Wifi; return }
Write-Host "  got a lease on 192.168.4.x" -ForegroundColor Green
Clear-DnsClientCache
Start-Sleep 3

Write-Host "== default route (must NOT be Wi-Fi) ==" -ForegroundColor Cyan
Get-NetRoute -DestinationPrefix '0.0.0.0/0' |
  Select-Object InterfaceAlias, NextHop, InterfaceMetric | Format-Table -AutoSize

Write-Host "== name resolution (must NOT be 192.168.4.1) ==" -ForegroundColor Cyan
try {
  $a = Resolve-DnsName api.anthropic.com -Type A -ErrorAction Stop | Select-Object -First 1
  if ($a.IPAddress -eq '192.168.4.1') {
    Write-Host "  HIJACKED - the AP is still acting as a resolver." -ForegroundColor Red
    Write-Host "  Reflash rv_hud_wifi_sniffer.ino with OFFER_GATEWAY_DNS 0."
  } else { Write-Host "  api.anthropic.com -> $($a.IPAddress)" -ForegroundColor Green }
} catch { Write-Host "  resolve failed: $($_.Exception.Message)" -ForegroundColor Red }

# HTTPS on purpose: the ESP32 has no TLS, so it cannot fake this the way it can
# fake a plain-HTTP connectivity probe with its own /generate_204 handler.
Write-Host "== internet over TLS ==" -ForegroundColor Cyan
try {
  $r = Invoke-WebRequest "https://www.google.com/generate_204" -TimeoutSec 20 -UseBasicParsing
  Write-Host "  https returned $($r.StatusCode) - genuine internet" -ForegroundColor Green
} catch { Write-Host "  NO INTERNET: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host "== the sniffer ==" -ForegroundColor Cyan
try {
  $d = Invoke-WebRequest "http://192.168.4.1/data" -TimeoutSec 12 -UseBasicParsing
  $j = $d.Content | ConvertFrom-Json
  $lock = if ($j.locked) { "LOCKED $($j.bitrate)" } else { "scanning..." }
  Write-Host "  reachable - $lock, frames=$($j.total), state=$($j.state), busErr=$($j.busErr)" -ForegroundColor Green
  Write-Host "  open http://192.168.4.1 in a browser for the full page"
} catch { Write-Host "  sniffer unreachable: $($_.Exception.Message)" -ForegroundColor Red }

Write-Host ""
Write-Host "Done. Run with -Revert to return to $HomeSsid." -ForegroundColor Cyan
