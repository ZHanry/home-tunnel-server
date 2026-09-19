"""Exercise Restic over a real TLS connection to a local S3 protocol test server.

Test dependency: moto[server]==5.1.12. No cloud account, outbound S3 traffic or
notifications are used. This verifies the protocol, not a cloud provider's SLA.
"""
from datetime import datetime, timedelta, timezone
import ipaddress, logging, os
from pathlib import Path
import subprocess, tempfile, threading
import boto3
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from moto.server import create_backend_app
from werkzeug.serving import make_server, WSGIRequestHandler

class QuietRequest(WSGIRequestHandler):
    def log_request(self,*args,**kwargs):pass

logging.getLogger('werkzeug').setLevel(logging.ERROR)
with tempfile.TemporaryDirectory(prefix='ht-s3-tls-') as directory:
    directory=Path(directory)
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    subject=x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME,'Home Tunnel test CA')])
    cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc)-timedelta(minutes=1))
        .not_valid_after(datetime.now(timezone.utc)+timedelta(hours=1))
        .add_extension(x509.BasicConstraints(ca=True,path_length=None),critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
        .sign(key,hashes.SHA256()))
    pem=directory/'ca.pem';private=directory/'key.pem'
    pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    server=make_server('127.0.0.1',0,create_backend_app('s3'),threaded=True,ssl_context=(str(pem),str(private)),request_handler=QuietRequest)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    origin=f'https://127.0.0.1:{server.server_port}'
    environment={**os.environ,'AWS_ACCESS_KEY_ID':'local-protocol-test','AWS_SECRET_ACCESS_KEY':'local-protocol-test',
        'AWS_DEFAULT_REGION':'us-east-1','RESTIC_CACERT':str(pem),'TEST_BACKUP_REPOSITORY':f's3:{origin}/home-tunnel-test'}
    environment.pop('TEST_RESTORE_BUNDLE_PATH',None)
    try:
        boto3.client('s3',endpoint_url=origin,verify=str(pem),aws_access_key_id='local-protocol-test',aws_secret_access_key='local-protocol-test',region_name='us-east-1').create_bucket(Bucket='home-tunnel-test')
        subprocess.run(['node','--test','deploy/backup/runner.test.mjs'],env=environment,check=True)
        print('HTTPS S3 encrypted backup, full restore and tamper rejection passed')
    finally:server.shutdown();worker.join(timeout=5)
