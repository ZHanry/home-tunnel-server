"""Exercise recovery only against temporary fixture databases; never a deployment."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing

spec=importlib.util.spec_from_file_location('rd_restore',Path(__file__).with_name('import-restore.py'))
restore=importlib.util.module_from_spec(spec);spec.loader.exec_module(restore)

class RemoteRestoreTests(unittest.TestCase):
    def test_restore_advances_epoch_and_disables_authority_without_modifying_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            source=Path(temporary)/'backup.sqlite3';target=Path(temporary)/'prepared.sqlite3'
            with closing(sqlite3.connect(source)) as db, db:
                db.executescript('''
                CREATE TABLE rd_server_state(id INTEGER PRIMARY KEY,restore_epoch INTEGER);
                INSERT INTO rd_server_state VALUES(1,3);
                CREATE TABLE rd_tokens(id TEXT,revoked_at TEXT); INSERT INTO rd_tokens VALUES('token',NULL);
                CREATE TABLE rd_sessions(id TEXT,state TEXT,close_reason TEXT,state_version INTEGER,closed_at TEXT);
                INSERT INTO rd_sessions VALUES('session','active',NULL,2,NULL);
                CREATE TABLE rd_session_slots(endpoint_id TEXT); INSERT INTO rd_session_slots VALUES('host');
                CREATE TABLE rd_challenges(id TEXT); INSERT INTO rd_challenges VALUES('challenge');
                CREATE TABLE rd_idempotency(id TEXT); INSERT INTO rd_idempotency VALUES('operation');
                CREATE TABLE rd_endpoints(id TEXT,local_enabled INTEGER); INSERT INTO rd_endpoints VALUES('host',1);
                CREATE TABLE rd_policy(scope_type TEXT,scope_id TEXT,policy_json TEXT,version INTEGER,updated_at TEXT,PRIMARY KEY(scope_type,scope_id));
                ''')
            original=source.read_bytes();restore.prepare_database(source,target)
            self.assertEqual(source.read_bytes(),original)
            with closing(sqlite3.connect(target)) as db:
                self.assertEqual(db.execute('SELECT restore_epoch FROM rd_server_state').fetchone()[0],4)
                self.assertIsNotNone(db.execute('SELECT revoked_at FROM rd_tokens').fetchone()[0])
                self.assertEqual(db.execute('SELECT state FROM rd_sessions').fetchone()[0],'closed')
                self.assertEqual(db.execute('SELECT count(*) FROM rd_session_slots').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT count(*) FROM rd_challenges').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT local_enabled FROM rd_endpoints').fetchone()[0],0)
                self.assertEqual(db.execute('SELECT policy_json FROM rd_policy').fetchone()[0],'{"enabled":false}')
            with self.assertRaisesRegex(ValueError,'new file'):restore.prepare_database(source,target)

    def test_legacy_database_copy_preserves_tunnel_tables(self):
        with tempfile.TemporaryDirectory() as temporary:
            source=Path(temporary)/'legacy.sqlite3';target=Path(temporary)/'prepared.sqlite3'
            with closing(sqlite3.connect(source)) as db, db:db.executescript("CREATE TABLE devices(id TEXT); INSERT INTO devices VALUES('legacy-tunnel');")
            restore.prepare_database(source,target)
            with closing(sqlite3.connect(target)) as db:self.assertEqual(db.execute('SELECT id FROM devices').fetchone()[0],'legacy-tunnel')
            self.assertGreaterEqual(restore.supported_schema(),13)

if __name__=='__main__':unittest.main()
