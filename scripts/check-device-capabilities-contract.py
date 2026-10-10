"""Verify the physical-device extension independently of frozen authentication."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
lock = json.loads((root/'contracts/device-capabilities.lock.json').read_text(encoding='utf8'))
assert lock['contract'] == 'nestlink-device-capabilities-v1'
assert lock['authentication_contract'] == 'api-v2.0.0'
expected_files = {'contracts/nestlink-device-capabilities.v1.json', 'contracts/nestlink-device-capabilities.v1.schema.json'}
assert len(lock['files']) == 2 and {entry['path'] for entry in lock['files']} == expected_files, 'Extension lock must pin exactly both contract files'
def verify_local_refs(document):
    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == '$ref' and isinstance(child, str) and child.startswith('#/'):
                    target = document
                    for token in child[2:].split('/'):
                        token = token.replace('~1', '/').replace('~0', '~')
                        assert isinstance(target, dict) and token in target, 'Unresolved extension reference: '+child
                        target = target[token]
                else: visit(child)
        elif isinstance(value, list):
            for child in value: visit(child)
    visit(document)
for entry in lock['files']:
    path = root/entry['path']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], 'Device capability contract drift: '+entry['path']
    assert (root/'control-center/public'/path.name).read_bytes() == path.read_bytes(), 'Public extension drift'
    verify_local_refs(json.loads(path.read_text(encoding='utf8')))
contract = json.loads((root/'contracts/nestlink-device-capabilities.v1.json').read_text(encoding='utf8'))
assert contract['contract_version'] == lock['contract']
assert contract['authentication_contract'] == lock['authentication_contract']
fields = contract['schemas']['DeviceCapabilityFields']
assert fields['required'] == [] and set(fields['properties']) == {'credential_purpose', 'client_type'}
operations = set()
for filename, prefix in [('account-devices.ts','/api/v2/auth'),('admin-device-capabilities.ts','/api/v2/admin')]:
    source = (root/'control-center/src/routes'/filename).read_text(encoding='utf8')
    for method, route in re.findall(r'router\.(get|post|delete)\(\s*"([^"]+)"', source):
        if route.startswith('/device-capabilities'):
            operations.add(method.upper()+' '+prefix+re.sub(r':([A-Za-z]+)',r'{\1}',route))
assert operations == set(contract['operations']), 'Capability extension route coverage drift'
openapi = json.loads((root/'contracts/openapi.v2.json').read_text(encoding='utf8'))
assert lock['contract'] in openapi['x-extensions']
assert openapi['x-contract-ref'] == 'api-v2.0.0'
assert {name: openapi['components']['schemas']['Device']['properties'][name] for name in fields['properties']} == fields['properties'], 'Aggregated device fields drift'
for operation in contract['operations'].values():
    assert operation['x-extension-ref'] == lock['contract']
print(f'{len(operations)} physical-device operations and independent schema digest verified')
