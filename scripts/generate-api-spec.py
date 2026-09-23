"""Build the versioned OpenAPI/JSON Schema; fail when a route lacks a contract.

Run from any directory. --check verifies checked-in output without modifying it.
The historical home-tunnel.v1.json fixture remains immutable at api-v1.0.0.
"""
from pathlib import Path
import json
import re
import sys
from remote_api_spec import install as install_remote_api

ROOT = Path(__file__).resolve().parents[1]
S = {"type": "string"}
B = {"type": "boolean"}
N = {"type": "number"}
I = {"type": "integer", "minimum": 0}
V = {"type": "integer", "minimum": 1}
ID = {"type": "string", "format": "uuid"}
DATE = {"type": "string", "format": "date-time"}
PORT = {"type": "integer", "minimum": 1, "maximum": 65535}
SECRET = {"type": "string", "writeOnly": True, "maxLength": 256}
schemas = {}
paths = {}

def string(n=256, minimum=0): return {"type":"string","minLength":minimum,"maxLength":n}
def enum(*values): return {"type":"string","enum":list(values)}
def nullable(value): return {"anyOf":[value,{"type":"null"}]}
def array(value, maximum=None, minimum=None):
    result={"type":"array","items":value}
    if maximum is not None: result["maxItems"]=maximum
    if minimum is not None: result["minItems"]=minimum
    return result
def obj(props, required=(), **extra): return {"type":"object","properties":props,"required":list(required),**extra}
def ref(name): return {"$ref":"#/components/schemas/"+name}
def define(name,props,required=()): schemas[name]=obj(props,required); return ref(name)
def page(item,extra=None): return obj({"items":array(item),"page":V,"page_size":V,"total":I,"total_pages":V,**(extra or {})},["items"])
def query(name,schema=S): return {"name":name,"in":"query","schema":schema}

runtime = enum("Disabled","Pending","Applying","Online","Degraded","Offline","Error")
role = enum("admin","user")
client_type=enum("web","windows","linux","macos","android","mobile")
transport=enum("http","tcp","udp")
application=nullable(enum("ssh","rdp","rtsp"))
version_body=obj({"expected_version":V})
user_props={"id":ID,"username":S,"display_name":S,"role":role,"status":enum("active","disabled"),"password_state":enum("normal","must_change"),"version":V}
define("User",user_props,["id","username","display_name","role","password_state"])
define("UserSummary",{**user_props,"device_count":I,"connection_count":I,"month_to_date_bytes":I,"bandwidth_limit_bps":nullable(I),"monthly_quota_bytes":nullable(I),"quota_suspended":B,"policy_version":V})
define("Identity",{**user_props,"device_id":nullable(ID),"capabilities":array(S),"bandwidth_limit_bps":nullable(I),"monthly_quota_bytes":nullable(I),"month_to_date_bytes":I,"quota_resets_at":DATE},["id","username","role","password_state","device_id"])
session_props={"access_token":S,"refresh_token":S,"csrf_token":S,"access_expires_at":DATE,"refresh_expires_at":DATE}
define("Session",{**session_props,"user":ref("User"),"password_change_required":B,"device_id":nullable(ID)},["user","csrf_token","access_expires_at","refresh_expires_at"])
schemas["Session"]["description"]="Native clients receive bearer tokens. Web clients use HttpOnly cookies and receive no bearer tokens in JSON."
define("Refresh",session_props,["csrf_token","access_expires_at","refresh_expires_at"])
define("Error",{"error_code":S,"message":S,"request_id":S,"field_errors":obj({},additionalProperties=S),"current_version":V,"current_access_policy_version":V,"current":obj({}),"suggestions":array(S)},["error_code","message"])
define("ManagementSession",{"id":ID,"client_type":S,"user_agent":S,"created_at":DATE,"updated_at":DATE,"refresh_expires_at":DATE,"current":B},["id","client_type","created_at","current"])
define("MfaStatus",{"enabled":B,"recovery_codes_remaining":I},["enabled","recovery_codes_remaining"])
define("MfaSetup",{"secret":S,"otpauth_uri":S,"expires_at":DATE},["secret","otpauth_uri","expires_at"])
define("RecoveryCodes",{"recovery_codes":array(S,8,8),"enabled":B},["recovery_codes"])
define("EnrollmentCode",{"id":ID,"name":S,"code":S,"created_at":DATE,"expires_at":DATE,"consumed_at":nullable(DATE),"revoked_at":nullable(DATE)},["id","name","expires_at"])
define("Registration",{"device_id":ID,"device_credential":S,"config_version":V,"name":S,"status":S,"created_at":DATE},["device_id","device_credential","config_version"])
define("EnrolledSession",{**schemas["Registration"]["properties"],**session_props},["device_id","device_credential","access_token","refresh_token","access_expires_at"])
define("Device",{"id":ID,"user_id":ID,"username":S,"name":S,"status":S,"config_version":V,"applied_config_version":I,"client_version":nullable(S),"agent_version":nullable(S),"last_seen_at":nullable(DATE),"lease_expires_at":nullable(DATE),"created_at":DATE,"online":B,"tags":array(string(32,1),12),"favorite":B,"metadata_version":V},["id","name","status","online","tags","favorite","metadata_version"])
define("AccessPolicyInput",{"ip_allowlist":nullable(array(string(64,1),64,1)),"basic_auth":nullable(obj({"username":string(64,1),"password":string(128,8)},["username","password"]))})
conn_input={"name":string(120,1),"subdomain":string(63,1),"local_scheme":enum("http","https"),"local_host":string(255,1),"local_port":PORT,"enabled":B,"proxy_type":transport,"application_protocol":application,"remote_port":nullable(PORT),"tcp_remote_port":nullable(PORT),"bandwidth_limit_bps":nullable(I),"access":ref("AccessPolicyInput")}
define("Connection",{k:v for k,v in {**conn_input,"id":ID,"user_id":ID,"device_id":ID,"public_url":nullable(S),"public_endpoint":nullable(S),"custom_domains":array(S),"version":V,"state":runtime,"applied_version":I,"last_error_code":nullable(S),"access_ip_allowlist":nullable(array(S)),"access_basic_auth_enabled":B,"access_policy_version":V,"policy_version":V,"username":S,"device_name":S,"proxy_name":S,"access_url":nullable(S)}.items() if k!="access"},["id","device_id","name","proxy_type","local_host","local_port","enabled","version","access_policy_version"])
define("ConnectionCreateAdmin",{**conn_input,"user_id":ID,"device_id":ID},["user_id","device_id","name","subdomain","local_scheme","local_host","local_port"])
define("ConnectionCreateClient",{**{k:v for k,v in conn_input.items() if k not in ("remote_port","tcp_remote_port")},"device_id":ID},["device_id","name","local_scheme","local_host","local_port"])
schemas["ConnectionCreateClient"]["description"]="HTTP requires subdomain. TCP/UDP allocate a port server-side; application presets require TCP. Creation depends on capabilities."
define("ConnectionPatch",{**conn_input,"expected_version":V,"expected_access_policy_version":V})
schemas["ConnectionPatch"]["description"]="Supply expected_version or If-Match; when access is present also supply expected_access_policy_version. ACL-only changes do not restart the agent."
schemas["ConnectionPatchClient"]={**schemas["ConnectionPatch"],"properties":{k:v for k,v in schemas["ConnectionPatch"]["properties"].items() if k not in ("bandwidth_limit_bps","proxy_type","remote_port","tcp_remote_port")}}
cap=obj({"enabled":B,"can_create":B,"port_start":PORT,"port_end":PORT},["enabled","can_create","port_start","port_end"])
define("ConnectionCapabilities",{"supported":B,"tcp":cap,"udp":cap,"automatic_ports":B},["supported","tcp","udp"])
pool_props={"enabled":B,"configured_enabled":B,"deployment_ready":B,"range_available":B,"pool_start":nullable(PORT),"pool_end":nullable(PORT),"port_start":PORT,"port_end":PORT,"allocated_ports":I,"available_ports":I,"active_connections":I}
define("TransportPools",{"tcp":obj(pool_props),"udp":obj(pool_props)},["tcp","udp"])
define("Settings",{"subdomain_prefix_policy":enum("off","suggest","enforce"),"default_subdomain_prefix_policy":enum("off","suggest","enforce"),"client_raw_tunnels_enabled":B,"transport_tunnels":ref("TransportPools"),"transport_settings_version":I},["subdomain_prefix_policy","client_raw_tunnels_enabled","transport_tunnels","transport_settings_version"])
pool_input=obj({"enabled":B,"port_start":PORT,"port_end":PORT})
define("SettingsPatch",{"subdomain_prefix_policy":enum("off","suggest","enforce"),"client_raw_tunnels_enabled":B,"transport_tunnels":obj({"tcp":pool_input,"udp":pool_input}),"transport_settings_version":I})
schemas["SettingsPatch"]["description"]="transport_settings_version is mandatory whenever transport_tunnels is present. Changes outside the deployment pool or in-use ports are rejected."
define("CustomDomain",{"id":ID,"connection_id":ID,"domain":S,"status":enum("pending","verified"),"created_at":DATE,"verified_at":nullable(DATE),"verification":obj({"txt_name":S,"txt_value":S,"cname_target":S})},["id","domain","status"])
define("Lease",{"lease":S,"expires_at":DATE,"config_version":V},["lease","expires_at","config_version"])
define("Sync",{"device_id":ID,"full_sync":B,"from_config_version":I,"target_config_version":V,"connections":array(ref("Connection")),"content_hash":S,"lease":nullable(ref("Lease")),"server_time":DATE},["device_id","full_sync","from_config_version","target_config_version","connections","content_hash","lease","server_time"])
runtime_report=obj({"connection_id":ID,"applied_version":I,"state":runtime,"error_code":nullable(string(64)),"error_summary":nullable(string(512))},["connection_id","applied_version","state"])
define("HeartbeatInput",{"device_id":ID,"applied_config_version":I,"client_version":string(64),"agent_version":string(64),"clock_utc":DATE,"connections":array(runtime_report,250)},["device_id","applied_config_version"])
define("BatchInput",{"enabled":B,"items":array(obj({"id":ID,"expected_version":V},["id","expected_version"]),50,1)},["enabled","items"])
define("BatchResults",{"results":array(obj({"id":ID,"status":{"type":"integer","enum":[200,400,403,404,409,423]},"connection":ref("Connection"),"error_code":S,"message":S,"current_version":V,"current":ref("Connection")},["id","status"]),50)},["results"])
define("Health",{"status":enum("healthy","degraded","unhealthy","unknown"),"components":array(obj({"component":S,"status":S,"version":S,"latency_ms":N,"pending":I,"oldest_age_seconds":I,"last_success_at":nullable(DATE),"snapshot":obj({}),"offsite":obj({}),"restore":obj({})})),"at":DATE},["status","components","at"])
define("Summary",{**{k:I for k in ["users","online_devices","connections","online_connections","upload_24h","download_24h","high_errors"]},"transport_tunnels":ref("TransportPools"),"tcp_tunnels":obj(pool_props),"at":DATE})
define("TrafficPolicy",{"scope_type":enum("user","connection"),"scope_id":ID,"bandwidth_limit_bps":nullable(I),"monthly_quota_bytes":nullable(I),"burst_bytes":nullable(I),"version":V,"updated_at":DATE})
define("AuditEvent",{"id":I,"actor_type":S,"actor_id":nullable(ID),"action":S,"target_type":S,"target_id":nullable(S),"before_value":{},"after_value":{},"request_id":S,"created_at":DATE,"ip_address":nullable(S)})
define("PublicConfig",{"public_base_url":S,"tunnel_domain":S,"subdomain_prefix_policy":enum("off","suggest","enforce"),"frps_host":S,"frps_port":PORT,"frps_tls_certificate_pem":S},["public_base_url","tunnel_domain","frps_host","frps_port"])
define("Capabilities",{"api_major":{"const":1},"contract_version":S,"server_version":S,"minimum_clients":obj({"desktop":S,"android":S,"agent":S}),"openapi_url":S,"schema_url":S,"features":array(S),"limits":obj({k:I for k in ["page_size","devices_per_account","connections_per_account","connections_per_device","batch_connections","device_tags","enrollment_seconds"]})},["api_major","contract_version","server_version","minimum_clients","features","limits"])
define("Release",{"version":S,"platform":S,"architecture":S,"file_name":S,"size_bytes":V,"sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"},"released_at":DATE,"download_url":S,"stable_download_url":S})
traffic_item=obj({"user_id":ID,"connection_id":ID,"username":S,"name":S,"subdomain":S,**{k:I for k in ["upload_bytes","download_bytes","request_count","requests","errors"]}})
credentials=obj({"password":SECRET,"mfa_code":string(128)},["password"])

def op(method,path,response=None,body=None,status=200,params=(),description=""):
    full=path if path.startswith('/internal/') else '/api/v1'+path
    path_parameters=[{"name":name,"in":"path","required":True,"schema":S} for name in re.findall(r'\{([^}]+)\}',full)]
    public=path.startswith('/public/') or path in ('/auth/login','/auth/device','/auth/refresh','/auth/enroll')
    internal=path.startswith('/internal/')
    security=[] if public or path in ('/internal/tls/allow','/internal/frps/plugin/{token}') else ([{"internalKey":[]}] if internal else [{"bearerAuth":[]},{"sessionCookie":[]}])
    responses={str(status):{"description":"Success"}}
    if response is not None: responses[str(status)]["content"]={"application/json":{"schema":response}}
    for code,label in [(400,"Invalid request"),(401,"Authentication or MFA failure"),(403,"Permission or CSRF failure"),(404,"Resource absent or not owned"),(409,"Version, policy or state conflict"),(423,"Account or device locked"),(429,"Rate or resource limit"),(503,"Dependency unavailable")]:
        responses[str(code)]={"description":label,"content":{"application/json":{"schema":ref("Error")}}}
    value={"operationId":method+'_'+re.sub(r'[^a-zA-Z0-9]+','_',path).strip('_'),"summary":method.upper()+' '+path,
      "tags":[path.split('/')[1]],"security":security,"parameters":path_parameters+list(params),"responses":responses,
      "description":description or ("Administrator management session required." if path.startswith('/admin/') else "Device sessions are limited to their own resources; management sessions can access account-owned resources.")}
    if body is not None:value["requestBody"]={"required":True,"content":{"application/json":{"schema":body}}}
    if method in ('patch','delete') and ('connections/' in path or 'traffic-policies/' in path or '/users/' in path):value['parameters'].append({"name":"If-Match","in":"header","schema":S,"description":"Quoted version; alternatively send expected_version in JSON."})
    if method not in ('get','head') and not public and not internal:value['parameters'].append({"name":"x-csrf-token","in":"header","schema":S,"description":"Required with cookie authentication. Obtain from auth/session. Not required with Bearer authentication."})
    paths.setdefault(full,{})[method]=value

op('get','/public/config',ref('PublicConfig'),description="HTTPS same-origin deployment discovery. FRPS certificate is optional for management clients.")
op('get','/public/capabilities',ref('Capabilities'),description="Feature and resource-limit discovery. Per-account creation permissions are in client/connections.capabilities.")
op('get','/public/releases/latest',ref('Release'),description="Legacy Windows download metadata. Prefer component GitHub releases for all supported platforms.")
paths['/api/v1/public/releases/latest']['get']['responses']['304']={"description":"ETag unchanged"}
op('post','/auth/login',ref('Session'),obj({"username":string(128,1),"password":SECRET,"mfa_code":string(128),"client_type":client_type},['username','password']))
op('post','/auth/device',ref('Session'),obj({"device_id":ID,"device_credential":SECRET},['device_id','device_credential']))
op('post','/auth/refresh',ref('Refresh'),obj({"refresh_token":SECRET,"client_type":client_type}),description="Web reads ht_refresh cookie. Native refresh replay revokes the family. Web retries reuse the same rotation for 30 seconds only with matching IP and user agent.")
op('post','/auth/logout',status=204,description="Revokes current management session; for a device-bound session also revokes that device credential.")
op('post','/auth/session/close',status=204,description="Closes only this session. Device credential remains valid; useful for diagnostic sessions.")
op('post','/auth/password/change',body=obj({"current_password":SECRET,"new_password":{**SECRET,"minLength":12},"mfa_code":string(128)},['current_password','new_password']),status=204)
op('get','/auth/me',ref('Identity'))
op('get','/auth/session',obj({"csrf_token":S,"session_id":ID},['csrf_token','session_id']))
op('get','/auth/sessions',obj({"items":array(ref('ManagementSession'),100),"has_more":B},['items','has_more']))
op('delete','/auth/sessions/{id}',status=204)
op('get','/auth/mfa',ref('MfaStatus'))
op('post','/auth/mfa/setup',ref('MfaSetup'),credentials)
op('post','/auth/mfa/confirm',ref('RecoveryCodes'),obj({**credentials['properties'],"code":{"type":"string","pattern":"^[0-9]{6}$"}},['password','code']))
op('post','/auth/mfa/recovery-codes',ref('RecoveryCodes'),credentials)
op('post','/auth/mfa/disable',body=credentials,status=204)
registration={"name":string(120,1),"install_id":string(128,8),"fingerprint_hash":{"type":"string","pattern":"^[a-fA-F0-9]{64}$"},"client_version":string(64)}
op('post','/devices/register',ref('Registration'),obj(registration,['name','install_id','fingerprint_hash']),201)
op('post','/devices/current/credential/rotate',obj({'device_id':ID,'device_credential':S},['device_id','device_credential']),obj({}))
op('post','/auth/enroll',ref('EnrolledSession'),obj({**registration,"code":string(128,24),"client_type":enum('windows','macos','linux')},['code','name','install_id','fingerprint_hash','client_version','client_type']),201)
op('post','/client/enrollment-codes',ref('EnrollmentCode'),obj({"name":string(120,1)},['name']),201)
op('get','/client/enrollment-codes',obj({"items":array(ref('EnrollmentCode'),100)},['items']))
op('delete','/client/enrollment-codes/{id}',status=204)
pagination=[query('page',V),query('page_size',{"type":"integer","minimum":1,"maximum":100}),query('search',string(120))]
for scope in ('client','admin'):
    admin=scope=='admin'
    op('get',f'/{scope}/devices',page(ref('Device')),params=pagination+([query('user_id'),query('status')] if admin else []))
    op('patch',f'/{scope}/devices/{{id}}/metadata',obj({"id":ID,"tags":array(S),"favorite":B,"metadata_version":V},['id','tags','favorite','metadata_version']),obj({"tags":array(string(32,1),12),"favorite":B,"expected_metadata_version":V},['tags','favorite','expected_metadata_version']))
    op('get',f'/{scope}/connections',page(ref('Connection'),{"capabilities":ref('ConnectionCapabilities')} if not admin else {"transport_tunnels":ref('TransportPools')}),params=pagination+([query('user_id')] if admin else []))
    op('post',f'/{scope}/connections',ref('Connection'),ref('ConnectionCreateAdmin' if admin else 'ConnectionCreateClient'),201)
    op('get',f'/{scope}/connections/{{connectionId}}',ref('Connection'))
    op('patch',f'/{scope}/connections/{{connectionId}}',ref('Connection'),ref('ConnectionPatch' if admin else 'ConnectionPatchClient'))
    op('delete',f'/{scope}/connections/{{connectionId}}',body=version_body,status=204)
    op('post',f'/{scope}/connections/batch',ref('BatchResults'),ref('BatchInput'),description="At most 50 distinct IDs. Independent per-item transactions and version checks. Inspect every result even on HTTP 200.")
    op('get',f'/{scope}/connections/{{connectionId}}/custom-domains',obj({"items":array(ref('CustomDomain'))},['items']))
    op('post',f'/{scope}/connections/{{connectionId}}/custom-domains',ref('CustomDomain'),obj({"domain":string(253,4)},['domain']),201)
    op('post',f'/{scope}/custom-domains/{{domainId}}/verify',ref('CustomDomain'))
    op('delete',f'/{scope}/custom-domains/{{domainId}}',status=204)
    op('get',f'/{scope}/traffic/summary',obj({"hours":I,"items":array(traffic_item)},['items']),params=[query('hours',I),query('user_id')] if admin else [])
op('get','/client/subdomains/availability',obj({"available":B,"subdomain":S,"reason":nullable(S),"suggestions":array(S),"policy":S}),params=[query('name'),query('connection_id'),query('user_id')])
op('post','/client/sync',ref('Sync'),obj({"device_id":ID,"last_config_version":I,"supports_optional_lease":B,"lease_expires_at":nullable(DATE),"supported_proxy_types":{**array(transport,3,1),"uniqueItems":True}},['device_id','last_config_version']))
op('post','/client/heartbeat',obj({"ok":B,"server_time":DATE,"clock_skew_seconds":{"type":"integer"}},['ok','server_time','clock_skew_seconds']),ref('HeartbeatInput'))
op('post','/client/runtime-report',obj({"accepted":I},['accepted']),obj({"device_id":ID,"reports":array(obj({**runtime_report['properties'],"observed_at":DATE},runtime_report['required']+['observed_at']),250,1)},['device_id','reports']),202)
op('post','/client/frp-lease',obj({**schemas['Lease']['properties'],"mode":enum('online','offline'),"max_offline_seconds":I},['lease','expires_at','config_version','mode','max_offline_seconds']),obj({"device_id":ID,"mode":enum('online','offline')},['device_id']))
op('get','/admin/users',obj({"items":array(ref('UserSummary'),100)},['items']),params=[query('search')])
temporary=obj({"user":ref('UserSummary'),"temporary_password":S,"expires_in_seconds":I},['temporary_password'])
op('post','/admin/users',temporary,obj({"username":string(32,3),"display_name":string(120,1),"role":{"const":"user"},"bandwidth_limit_bps":nullable(I)},['username','display_name']),201)
op('get','/admin/users/{userId}',ref('UserSummary'))
op('patch','/admin/users/{userId}',ref('UserSummary'),obj({"display_name":string(120,1),"expected_version":V},['display_name']))
op('delete','/admin/users/{userId}',body=version_body,status=204)
for action in ('disable','enable'):op('post','/admin/users/{userId}/'+action,ref('UserSummary'),status=202)
op('post','/admin/users/{userId}/reset-password',temporary)
op('delete','/admin/devices/{deviceId}',status=204)
op('post','/admin/devices/{deviceId}/revoke',status=204)
op('get','/admin/summary',ref('Summary'))
op('get','/admin/system/health',ref('Health'))
op('get','/admin/settings',ref('Settings'))
op('patch','/admin/settings',ref('Settings'),ref('SettingsPatch'))
op('get','/admin/audit-events',page(ref('AuditEvent')),params=pagination+[query('query'),query('action'),query('target_type')])
op('get','/admin/traffic-policies/{scopeType}/{scopeId}',ref('TrafficPolicy'))
op('patch','/admin/traffic-policies/{scopeType}/{scopeId}',ref('TrafficPolicy'),obj({"bandwidth_limit_bps":nullable(I),"monthly_quota_bytes":nullable(I),"expected_version":V}))
op('post','/admin/alerts/test',obj({"configured":obj({"webhook":B,"telegram":B}),"delivered":B,"results":array(obj({"channel":S,"delivered":B,"status":S,"error":S}))}),description="Administrator-triggered test sends notifications to already configured channels.")
policy_connection={"connection_id":ID,"user_id":ID,"device_id":ID,"subdomain":S,"custom_domains":array(S),"enabled":B,"device_lease_expires_at":nullable(DATE),"connection_version":V,"access_ip_allowlist":nullable(array(S)),"access_basic_user":nullable(S),"access_basic_hash":nullable(S),"access_policy_version":V,**{k:nullable(I) for k in ('connection_limit_bps','connection_burst_bytes','user_limit_bps','user_burst_bytes')},"connection_policy_version":V,"user_policy_version":V}
op('get','/internal/policies/sync',obj({"revision":I,"generated_at":DATE,"snapshot_expires_at":DATE,"tunnel_domain":S,"connections":array(obj(policy_connection))}),description="Internal authenticated gateway snapshot. Contains credential hashes; never expose publicly. Supports ETag/304.")
paths['/internal/policies/sync']['get']['responses']['304']={"description":"Unchanged; expiry renewed in x-policy-snapshot-expires-at"}
sample=obj({"bucket_start":DATE,"bucket_seconds":{"type":"integer","minimum":1,"maximum":3600},"user_id":ID,"device_id":ID,"connection_id":ID,**{k:I for k in ('upload_bytes','download_bytes','request_count','error_count')}},['bucket_start','bucket_seconds','user_id','device_id','connection_id','upload_bytes','download_bytes','request_count','error_count'])
op('post','/internal/traffic/samples',obj({"accepted":I}),obj({"batch_id":ID,"samples":array(sample,1000)},['batch_id','samples']),202)
op('get','/internal/health/dependencies',ref('Health'))
op('get','/internal/tls/allow',status=204,params=[query('domain')],description="Private Caddy certificate authorization hook. Network isolated; never publish internal service ports.")
op('get','/internal/metrics',description="Prometheus exposition; internal key required.")
paths['/internal/metrics']['get']['responses']['200']['content']={'text/plain':{'schema':S}}
op('get','/internal/policies/events',description="Server-sent events: ready, policy ({at}), keepalive comments. Internal key required.")
paths['/internal/policies/events']['get']['responses']['200']['content']={'text/event-stream':{'schema':S}}
op('post','/internal/frps/plugin/{token}',obj({"reject":B,"reject_reason":S,"unchange":B,"content":obj({})}),obj({"version":S,"op":enum('Login','NewProxy','CloseProxy','Ping','NewWorkConn','NewUserConn'),"content":obj({"user":{},"metas":obj({},additionalProperties=S),"metadatas":obj({},additionalProperties=S),"proxy_name":S,"proxy_type":S,"remote_port":PORT,"custom_domains":array(S)},additionalProperties=True)},['op','content']),description="FRP 0.68-compatible private plugin protocol. Path token is secret. Content fields depend on the upstream operation; unknown fields are preserved.")

op('post','/internal/monitoring/alerts',obj({'accepted':I}),obj({'alerts':array(obj({'status':enum('firing','resolved'),'fingerprint':string(128),'labels':obj({'alertname':string(120,1),'severity':string(32)},['alertname']),'annotations':obj({'summary':string(500),'description':string(2000)},['summary'])},['status','fingerprint','labels','annotations']),100)},['alerts']),description='Authenticated Alertmanager receiver. Relays to deployment-configured Webhook/Telegram destinations only; retries failed delivery.')

install_remote_api(globals())

# Every concrete router operation must be represented. Dynamic route paths must
# add an explicit entry and extend this scanner; they must never silently vanish.
source_routes=set()
for source in (ROOT/'control-center/src/routes').rglob('*.ts'):
    prefix='/admin' if source.parent.name=='admin' else {'auth.ts':'/auth','account-security.ts':'/auth','public.ts':'/public','internal.ts':'/internal'}.get(source.name,'')
    for match in re.finditer(r'(router|publicRouter|admin)\.(get|post|put|patch|delete)\(\s*("[^"]+"|\[[^\]]+\])',source.read_text(encoding='utf-8')):
        for path in re.findall(r'"([^"]+)"',match[3]):
            route_prefix = ('/admin/rd' if match[1] == 'admin' else '/rd') if source.name == 'remote-desktop.ts' else prefix
            path=re.sub(r':([a-zA-Z]+)',r'{\1}',route_prefix+path)
            full=path if path.startswith('/internal/') else '/api/v1'+path
            source_routes.add((match[2],full))
health=obj({'status':enum('healthy','unhealthy'),'version':S,'at':DATE},['status','version','at'])
paths['/healthz']={'get':{'operationId':'healthz','summary':'Public readiness check','security':[],
    'responses':{str(code):{'description':'Ready' if code==200 else 'Database unavailable','content':{'application/json':{'schema':health}}} for code in (200,503)}}}
assert 'app.get("/healthz"' in (ROOT/'control-center/src/server.ts').read_text(encoding='utf-8')
source_routes.add(('get','/healthz'))
documented={(method,path) for path,methods in paths.items() for method in methods}
assert source_routes==documented, f"Route drift: missing={source_routes-documented}, removed={documented-source_routes}"
errors=sorted(set(re.findall(r'new HttpError\(\s*\d+,\s*"([A-Z0-9_]+)"', '\n'.join(p.read_text(encoding='utf-8') for p in (ROOT/'control-center/src').rglob('*.ts') if not p.name.endswith('.test.ts')))))
schemas['Error']['properties']['error_code']['description']='Known codes (consumers must handle unknown codes): '+', '.join(errors)
document={"openapi":"3.1.0","info":{"title":"Home Tunnel API","version":"1.2.0","description":"Home Tunnel 8.0 API contract. Additive remote-desktop control plane; direct UDP media is never relayed here. Existing tunnel WebSocket envelopes remain in home-tunnel.v1.json; RD wire registry is remote-desktop.v1.json. See docs/API.md for authentication, compatibility and replay semantics.","license":{"name":"Apache-2.0"}},"servers":[{"url":"https://console.example.com"}],"security":[{"bearerAuth":[]},{"sessionCookie":[]}],"paths":paths,"components":{"securitySchemes":{"bearerAuth":{"type":"http","scheme":"bearer"},"sessionCookie":{"type":"apiKey","in":"cookie","name":"ht_access"},"internalKey":{"type":"apiKey","in":"header","name":"x-home-tunnel-key"},"dpopAuth":{"type":"http","scheme":"DPoP","description":"Short-lived endpoint token; requires a matching DPoP proof."},"dpopProof":{"type":"apiKey","in":"header","name":"DPoP","description":"ES256 proof binds token hash, nonce, HTTP method, canonical URL, timestamp and unique jti."}},"schemas":schemas},"x-contract-ref":"api-v1.2.0"}
encoded=json.dumps(document,ensure_ascii=False,indent=2)+'\n'
json_schema={"$schema":"https://json-schema.org/draft/2020-12/schema","$id":"https://zhanry.github.io/home-tunnel/schemas/api-v1.2.0.json","$defs":schemas}
schema_encoded=json.dumps(json_schema,ensure_ascii=False,indent=2).replace('#/components/schemas/','#/$defs/')+'\n'
outputs={'contracts/openapi.v1.json':encoded,'contracts/api.schema.json':schema_encoded,'control-center/public/openapi.json':encoded,'control-center/public/api-schema.json':schema_encoded}
for name,content in outputs.items():
    target=ROOT/name
    if '--check' in sys.argv: assert target.read_text(encoding='utf-8')==content, f'Regenerate {name}'
    else:target.write_text(content,encoding='utf-8',newline='\n')
print(f'{len(documented)} HTTP operations; {len(schemas)} shared schemas; route coverage complete')
