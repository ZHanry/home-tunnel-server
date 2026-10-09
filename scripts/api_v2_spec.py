"""Account and native P2P additions; legacy tunnel operations stay under /api/v1."""
from copy import deepcopy


def install(context):
    schemas, paths = context['schemas'], context['paths']
    obj, enum, array, ref, define, op = (context[key] for key in ('obj','enum','array','ref','define','op'))
    S, B, I, ID, DATE, SECRET = (context[key] for key in ('S','B','I','ID','DATE','SECRET'))
    strict = lambda props, required=(): obj(props, required, additionalProperties=False)
    sha = {'type':'string','pattern':'^[a-f0-9]{64}$'}
    device_key = {'type':'string','pattern':'^[A-Za-z0-9+/]{43}=$'}
    proof = {'type':'string','pattern':'^[A-Za-z0-9+/]{86}==$'}
    remote_id = {'type':'string','pattern':'^[A-Za-z0-9_-]{1,64}$'}
    for path, operations in list(paths.items()):
        if path.startswith(('/api/v1/auth/', '/api/v1/homedesk/')) and 'native-remote' not in path:
            new_path=path.replace('/api/v1/', '/api/v2/', 1)
            paths[new_path]=deepcopy(operations)
            for operation in paths[new_path].values(): operation['operationId']='v2_'+operation['operationId']

    trust=define('PermitTrust', {'algorithm':{'const':'Ed25519'}, 'public_key':device_key, 'realm':sha,
        'permit_seconds':{'const':45}, 'heartbeat_seconds':{'const':5}, 'peer_timeout_seconds':{'const':20}},
        ['algorithm','public_key','realm','permit_seconds','heartbeat_seconds','peer_timeout_seconds'])
    define('HomeDeskConfigV2', {**schemas['HomeDeskConfig']['properties'], 'permit_trust':trust},
        schemas['HomeDeskConfig']['required']+['permit_trust'])
    presence={'device_id':ID,'session_id':ID,'configured':{'const':True},'server':S,'key':S,'key_sha256':sha,
        'family_cidr':S,'source_cidr':S,'permit_trust':trust}
    define('NativePresence', presence, list(presence))
    registration={'name':{'type':'string','minLength':1,'maxLength':120},
        'install_id':{'type':'string','minLength':8,'maxLength':128},'fingerprint_hash':sha,
        'client_version':{'type':'string','minLength':1,'maxLength':64},
        'client_type':enum('windows','macos','linux','android','cli','nas'), 'credential_purpose':enum('gui','background')}
    registered={**schemas['Registration']['properties'], **context['session_props'], 'credential_purpose':enum('gui','background')}
    define('RegisteredDeviceSession', registered, ['device_id','device_credential','credential_purpose','config_version','access_token','refresh_token','csrf_token','access_expires_at','refresh_expires_at'])
    op('post','/api/v2/auth/devices',ref('RegisteredDeviceSession'),strict(registration,list(registration)),201,
        description='Account management session required. GUI devices depend on the current management session. Background credentials remain independent; a duplicate background fingerprint returns 409 without rotating its credential.')
    op('delete','/api/v2/auth/devices/{id}',status=204,
        description='Soft-revoke an account-owned device and its sessions. Preserve device identity and tunnel configurations; terminate its runtime credentials and leases.')
    paths['/api/v2/homedesk/config']['get']['responses']['200']['content']['application/json']['schema']=ref('HomeDeskConfigV2')
    paths['/api/v2/homedesk/devices']['get']['responses']['200']['content']['application/json']['schema']=obj({'items':array(ref('HomeDeskBinding'),1000),'version':{'const':2}},['items','version'])
    paths['/api/v2/homedesk/devices']['get']['description']='Same-account directory. Online requires recent cryptographic binding and a live GUI session whose parent management session is live. It does not prove P2P reachability.'
    binding={k:v for k,v in schemas['HomeDeskBinding']['properties'].items() if k not in ('last_seen','online')}
    binding.update(remote_public_key=device_key,remote_proof=proof)
    operation=paths['/api/v2/homedesk/devices/current']['put']
    operation['requestBody']['content']['application/json']['schema']=strict(binding,list(binding))
    operation['description']='GUI device session required. Verify Ed25519 signature over UTF-8 NestLink-binding-v2:<realm>:<device_id>:<remote_id> using the hbbs-confirmed device public key.'
    op('get','/api/v2/remote/presence',ref('NativePresence'),description='Live GUI session with live management parent required. Public signing trust and hbbs configuration; private credentials are never returned.')
    define('RemotePermit', {'permit_id':ID,'permit':{'type':'string','maxLength':4096},'expires_at':DATE,'policy':{'const':'require_direct'}},['permit_id','permit','expires_at','policy'])
    op('post','/api/v2/remote/permits',ref('RemotePermit'),strict({'target_id':remote_id},['target_id']),201,
        description='Look up a target device ID in this deployment, including another account. Both endpoints need live GUI logins and signed bindings. No target account directory is exposed. Approval or remote password is still required by the host.')
    op('post','/api/v2/remote/permits/{id}/accept',strict({'permit_id':ID,'active':{'const':True},'peer_timeout_seconds':{'const':20}},['permit_id','active','peer_timeout_seconds']),
        strict({'connection_id':{'type':'string','pattern':'^[1-9][0-9]{0,19}$'}},['connection_id']),
        description='Host GUI session only. Bind permit to one native LoginRequest.session_id. A different ID is a replay (409). Native core verifies controller Ed25519 proof before calling this endpoint.')
    op('post','/api/v2/remote/permits/{id}/heartbeat',strict({'permit_id':ID,'active':B,'expires_at':DATE},['permit_id','active','expires_at']),strict({}),
        description='Either bound endpoint refreshes every 5 seconds. Active permit expires if the peer has not refreshed for 20 seconds. Pending permit cannot extend its original 45-second deadline.')
    op('delete','/api/v2/remote/permits/{id}',status=204,description='Either bound endpoint may end the remote permit. This does not stop independent tunnels.')
    define('CapabilitiesV2', {**deepcopy(schemas['Capabilities']['properties']), 'api_major':{'const':2},
        'authentication':obj({'mode':{'const':'self_hosted_account'},'devices_path':S,'gui_requires_management_session':{'const':True},'background_independent':{'const':True}}),
        'remote':obj({'permits_path':S,'algorithm':{'const':'Ed25519'},'permit_seconds':{'const':45},'heartbeat_seconds':{'const':5},'require_direct':{'const':True},'cross_account_by_id':{'const':True}})},
        schemas['Capabilities']['required']+['authentication','remote'])
    schemas['CapabilitiesV2']['properties']['homedesk']['properties']['directory_version']={'const':2}
    op('get','/api/v2/public/capabilities',ref('CapabilitiesV2'),description='Account API v2 and compatible API v1 tunnel capabilities.')
    define('ReleaseV2',{'version':S,'url':S,'notes':{'type':'string','maxLength':24000},'prerelease':B},['version','url','notes','prerelease'])
    op('get','/api/v2/public/updates/{component}',obj({'current_version':S,'channel':enum('stable','rc'),'update_available':B,'latest':ref('ReleaseV2')},['current_version','channel','update_available','latest']),
        params=[context['query']('channel',enum('stable','rc'))], description='Component is server, client, or android. Stable channel excludes RCs; RC channel compares numeric RC sequence including legacy rc.N. URLs are generated from fixed official repositories; upstream drafts are ignored.')
    paths['/api/v2/public/updates/{component}']['get']['parameters'][0]['schema']=enum('server','client','android')
