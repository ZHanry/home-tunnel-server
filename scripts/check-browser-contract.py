"""Verify the independently versioned browser extension without rewriting frozen API v2."""
from pathlib import Path
import hashlib, json, re

root=Path(__file__).resolve().parents[1]
lock=json.loads((root/'contracts/browser.lock.json').read_text(encoding='utf-8'))
for file in lock['files']:
    assert hashlib.sha256((root/file['path']).read_bytes()).hexdigest()==file['sha256'], 'Browser contract drift'
contract=json.loads((root/'contracts/nestlink-browser.v1.json').read_text(encoding='utf-8'))
source=(root/'control-center/src/routes/browser-remote.ts').read_text(encoding='utf-8')
routes={method.upper()+' '+re.sub(r':([a-zA-Z]+)',r'{\1}',route)
        for method,route in re.findall(r'router\.(get|post|delete)\(\s*"([^"]+)"',source)}
assert routes==set(contract['operations']), 'Browser route coverage drift'
assert contract['transport']['relay'] is False and contract['transport']['ice_tcp'] is False
assert contract['authentication_contract']==lock['authentication_contract']=='api-v2.0.0'
print(f'{len(routes)} browser operations and separate contract digest verified')
