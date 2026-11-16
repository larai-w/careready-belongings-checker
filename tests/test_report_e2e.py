"""Regression tests for extracting executed E2E results from a Chrome DOM dump."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

REPORT = Path(__file__).resolve().parents[1] / 'scripts' / 'report_e2e.py'


class ReportTests(unittest.TestCase):
    def report(self, html):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory) / 'dump.html'
            fixture.write_text(html, encoding='utf-8')
            return subprocess.run([sys.executable, str(REPORT), str(fixture)], capture_output=True, text=True)

    def test_complete_executed_result_passes_and_decodes_text(self):
        result = self.report('<pre id="log">PASS: 個数 &gt;= 2\nE2E_RESULT: ALL_PASS\nDONE\n</pre>')
        self.assertEqual(result.returncode, 0)
        self.assertIn('個数 >= 2', result.stdout)

    def test_source_and_comment_markers_do_not_count(self):
        result = self.report('<!-- E2E_RESULT: ALL_PASS --><script>"E2E_RESULT: ALL_PASS"</script><pre id="log">PASS: first</pre>')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('<script>', result.stdout)

    def test_failure_after_forty_passes_remains_visible(self):
        lines = ['PASS: synthetic ' + str(n) for n in range(45)]
        lines += ['FAIL: late failure', 'E2E_RESULT: FAILURES=1', 'DONE']
        result = self.report('<pre id="log">' + '\n'.join(lines) + '</pre>')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FAIL: late failure', result.stdout)
        self.assertIn('E2E_RESULT: FAILURES=1', result.stdout)

    def test_truncated_success_is_not_complete(self):
        result = self.report('<pre id="log">E2E_RESULT: ALL_PASS</pre>')
        self.assertNotEqual(result.returncode, 0)

    def test_runtime_error_prevents_success(self):
        result = self.report('<pre id="log">WINDOW_ERR: synthetic\nE2E_RESULT: ALL_PASS\nDONE</pre>')
        self.assertNotEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
