"""Startup failure regressions; real packet checks still run separately on Linux."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('stun_runtime', Path(__file__).resolve().parents[2] / 'tests/stun-runtime.py')
RUNTIME = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNTIME)


def state(status, running=True):
    return json.dumps({'Running': running, 'Pid': 123, 'ExitCode': 0 if running else 137,
                       'OOMKilled': not running, 'Error': '',
                       'Health': {'Status': status, 'Log': [{'ExitCode': -1, 'Output': 'Health check exceeded timeout'}]}})


class StartupTests(unittest.TestCase):
    def test_timed_out_probe_does_not_abort_a_later_healthy_start(self):
        report = {}
        with patch.object(RUNTIME, 'run', side_effect=[state('starting'), state('unhealthy'), state('healthy')]) as run, \
                patch.object(RUNTIME.time, 'sleep'):
            result = RUNTIME.wait_for_health('owned-container', report)
        self.assertEqual(result['Pid'], 123)
        self.assertEqual(report['container_state']['Health']['Status'], 'healthy')
        self.assertTrue(all(call.args[:2] == ('docker', 'inspect') for call in run.call_args_list))

    def test_persistent_timeouts_fail_with_original_health_diagnostics(self):
        report = {}
        with patch.object(RUNTIME, 'run', return_value=state('unhealthy')), \
                patch.object(RUNTIME.time, 'monotonic', side_effect=[0, 61, 61]):
            with self.assertRaisesRegex(RuntimeError, 'never passed within 60s'):
                RUNTIME.wait_for_health('owned-container', report)
        self.assertIn('exceeded timeout', report['container_state']['Health']['Log'][0]['Output'])

    def test_container_crash_fails_immediately_and_keeps_oom_diagnostics(self):
        report = {}
        with patch.object(RUNTIME, 'run', return_value=state('unhealthy', running=False)), \
                patch.object(RUNTIME.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'exit=137, OOMKilled=True'):
                RUNTIME.wait_for_health('owned-container', report)
        sleep.assert_not_called()
        self.assertTrue(report['container_state']['OOMKilled'])

    def test_missing_healthcheck_cannot_satisfy_readiness(self):
        report = {}
        raw = json.loads(state('healthy'))
        del raw['Health']
        with patch.object(RUNTIME, 'run', return_value=json.dumps(raw)), \
                patch.object(RUNTIME.time, 'monotonic', side_effect=[0, 61, 61]):
            with self.assertRaisesRegex(RuntimeError, 'last status=missing'):
                RUNTIME.wait_for_health('owned-container', report)


if __name__ == '__main__':
    unittest.main()
