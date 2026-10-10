"""Independently versioned physical-device directory extension to frozen API v2."""
from copy import deepcopy

CONTRACT = 'nestlink-device-capabilities-v1'
AUTHENTICATION_CONTRACT = 'api-v2.0.0'


def install(context):
    schemas, paths = context['schemas'], context['paths']
    obj, enum, array, ref, define, op = (context[key] for key in ('obj','enum','array','ref','define','op'))
    ID = context['ID']
    strict = lambda props, required=(): obj(props, required, additionalProperties=False)
    ids = {'physical_device_id':ID,'remote_device_id':ID,'tunnel_device_id':ID}
    define('DeviceCapabilityFields', {'credential_purpose':enum('gui','background'),
           'client_type':context['nullable'](deepcopy(context['S']))})
    schemas['Device']['properties'].update(deepcopy(schemas['DeviceCapabilityFields']['properties']))
    define('LinkedDeviceCapabilities',ids,list(ids))
    active = {**ids,'remote_device_id':context['nullable'](ID),'tunnel_device_id':context['nullable'](ID)}
    define('DeviceCapabilities',active,list(active))
    define('AdminDeviceCapabilities',{'user_id':ID,**active},['user_id',*active])
    op('post','/api/v2/auth/device-capabilities/link',ref('LinkedDeviceCapabilities'),
        strict({'remote_device_id':ID,'tunnel_device_id':ID},['remote_device_id','tunnel_device_id']),201,
        description='Account management session and cookie CSRF required. Explicitly link active same-account GUI and background subjects one-to-one. Never infer identity from names. Repeating the same pair returns 200; conflicting associations return 409. No credentials, services or scopes are moved.')
    operation=paths['/api/v2/auth/device-capabilities/link']['post']
    operation['responses']['200']=deepcopy(operation['responses']['201'])
    op('get','/api/v2/auth/device-capabilities',obj({'version':{'const':1},'items':array(ref('DeviceCapabilities'))},['version','items']),
        description='Live account management session required. Return only account-owned IDs. Revoked capabilities are null. The physical identity remains the original GUI UUID while either capability is active. Old device/service requests continue using subject UUIDs.')
    op('delete','/api/v2/auth/device-capabilities/{remoteId}',status=204,
        description='Account management session and cookie CSRF required. Atomically revoke both subjects, their sessions and leases, with outbox and audit. Preserve service configuration. Use the canonical GUI UUID.')
    paths['/api/v2/auth/device-capabilities/{remoteId}']['delete']['responses']['500']={
        'description':'The entire transaction failed; neither subject was partially revoked.',
        'content':{'application/json':{'schema':ref('Error')}}}
    op('get','/api/v2/admin/device-capabilities',obj({'version':{'const':1},'items':array(ref('AdminDeviceCapabilities'))},['version','items']),
        params=[context['query']('user_id',ID)],
        description='Live administrator account management session required. Read-only associations across accounts, optionally filtered by owner UUID. Each link retains its owner and both stored subject IDs, including revoked subjects for administrative record management. No link or revocation writes are provided here; account-scoped operations never gain administrative scope.')
    for path in ('/api/v2/auth/device-capabilities/link','/api/v2/auth/device-capabilities',
                 '/api/v2/auth/device-capabilities/{remoteId}','/api/v2/admin/device-capabilities'):
        for operation in paths[path].values(): operation['x-extension-ref']=CONTRACT
    paths['/api/v2/auth/devices/{id}']['delete']['x-extension-ref']=CONTRACT
    paths['/api/v2/auth/devices/{id}']['delete']['description']+=' For explicitly linked subjects, the device-capabilities-v1 extension atomically revokes both subjects and preserves service configurations.'


def document(context):
    result = {
        'contract_version': CONTRACT, 'authentication_contract': AUTHENTICATION_CONTRACT,
        'version': 1, 'migration': 26,
        'operations': {method.upper()+' '+path: deepcopy(operation)
                       for path, methods in context['paths'].items()
                       for method, operation in methods.items()
                       if '/device-capabilities' in path},
        'compatibility': {
            'device_credential_purpose': 'Optional gui/background field on legacy subject directories',
            'device_client_type': 'Optional nullable platform string from the remote binding or latest session on legacy subject directories',
            'device_directory_fields_schema': '#/schemas/DeviceCapabilityFields',
            'linked_subject_revocation': 'DELETE /api/v2/auth/devices/{id} revokes both explicitly linked subjects',
            'canonical_id': 'Original GUI UUID; never substitute it for the remote or tunnel subject UUID',
            'old_server': 'Only HTTP 404 means the extension is unavailable; never infer associations from names',
            'identity': 'GUI/background UUIDs, credentials, service assignments and frozen auth/permit semantics remain unchanged',
        },
        'schemas': {name: deepcopy(context['schemas'][name]) for name in
                    ('LinkedDeviceCapabilities','DeviceCapabilities','AdminDeviceCapabilities','DeviceCapabilityFields','Error')},
    }
    result['schemas']['Error']['properties']['error_code']['description'] += ', DEVICE_CAPABILITY_LINK_CONFLICT, DEVICE_CAPABILITY_SUBJECT_INVALID'
    def local_refs(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == '$ref': value[key] = child.replace('#/components/schemas/', '#/schemas/')
                else: local_refs(child)
        elif isinstance(value, list):
            for child in value: local_refs(child)
    local_refs(result)
    return result
