"""Verify that the build locks contain the reviewed NTLM security override."""
from pathlib import Path
import hashlib
import json
import re

root=Path(__file__).resolve().parents[1]
component=json.loads((root/'compatibility.json').read_text())['component']
folder=root/('agent' if component=='client' else 'deploy/frps')
mod_path=folder/('frp-go.mod' if component=='client' else 'go.mod')
sum_path=folder/('frp-go.sum' if component=='client' else 'go.sum')
pins=json.loads((folder/'security-pins.json').read_text())
assert hashlib.sha256(mod_path.read_bytes()).hexdigest()==pins['go_mod_sha256']
assert hashlib.sha256(sum_path.read_bytes()).hexdigest()==pins['go_sum_sha256']
for override in pins['module_overrides']:
    module=override['path']
    expected=override['version']
    assert expected == {'github.com/Azure/go-ntlmssp': 'v0.1.1', 'golang.org/x/crypto': 'v0.56.0', 'github.com/gorilla/websocket': 'v1.5.3'}[module], 'Review changed security pins'
    versions=re.findall(r'^\s*'+re.escape(module)+r'\s+(\S+)',mod_path.read_text(),re.M)
    assert versions==[expected], 'FRP build lock does not contain the security fix'
    sums=sum_path.read_text()
    assert f'{module} {expected} {override["sum"]}' in sums
    assert f'{module} {expected}/go.mod {override["go_mod_sum"]}' in sums
    if component=='client' and module != 'github.com/gorilla/websocket':
        assert re.findall(r'^\s*'+re.escape(module)+r'\s+(\S+)',(folder/'go.mod').read_text(),re.M)==[expected]
print('Reviewed FRP security locks verified: NTLM v0.1.1, crypto v0.56.0')
