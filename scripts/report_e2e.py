#!/usr/bin/env python3
"""Read the executed E2E log, excluding HTML comments and script source."""
from html.parser import HTMLParser
from pathlib import Path
import sys


class E2ELog(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_log = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'pre' and dict(attrs).get('id') == 'log':
            self.in_log = True

    def handle_endtag(self, tag):
        if tag == 'pre':
            self.in_log = False

    def handle_data(self, data):
        if self.in_log:
            self.parts.append(data)


def main():
    parser = E2ELog()
    parser.feed(Path(sys.argv[1]).read_text(encoding='utf-8'))
    lines = ''.join(parser.parts).splitlines()
    for line in lines:
        print(line)
    complete = len(lines) >= 2 and lines[-2:] == ['E2E_RESULT: ALL_PASS', 'DONE']
    errors = any(line.startswith(('FAIL:', 'ERR:', 'WINDOW_ERR:')) for line in lines)
    if not complete:
        print('E2E report incomplete or failed.')
    return 0 if complete and not errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
