# Playbook: Python 2 → Python 3

Plan mode is on. Plan it so the code keeps working on Python 2 until the switch (a 2-and-3 compatible codebase), then drop Python 2 in its own step.

## 1. Where it stands

- Entry points, how it's run and deployed, the Python 2 version, test coverage (`coverage run -m pytest` or the existing runner). Low coverage on a module is a risk to note: the hard bugs (bytes vs text) only show at run time.
- Dependencies: which have Python 3 versions (`caniusepython3` if available, or check each on PyPI), which are abandoned and need replacements.
- The risky areas: anything that reads or writes files, sockets, subprocess output, HTTP bodies, CSV, pickles, hashing, database drivers, C extensions.

## 2. Phases

1. **Safety net**: tests running on Python 2 in CI; add tests where coverage is thin around I/O. Add `from __future__ import absolute_import, division, print_function, unicode_literals` module by module.
2. **Mechanical pass** with a codemod: `python-modernize` / `futurize --stage1` then `--stage2` (or `pyupgrade` once on 3), reviewed like any codemod: `print`, `except X as e`, `dict.iteritems/iterkeys/has_key`, `xrange`, `unicode`/`basestring`, `raw_input`, `urllib`/`urllib2`, `ConfigParser`, octal literals, `<>`, backticks, relative imports, `__metaclass__`, `string.letters`.
3. **The hard part, by hand**: bytes vs text at every boundary (decode on input, encode on output, `open(..., encoding=)`, `io.open`, `subprocess` with `text=True`), `/` vs `//`, `map`/`filter`/`zip`/`dict.keys()` returning views or iterators, sorting mixed types and `cmp=`, `__nonzero__`/`__unicode__`/`__div__`, `round()` banker's rounding, `hash()` randomization, pickles written by Python 2 (`encoding='latin1'`).
4. **Dependencies**: upgrade or replace each one that has no Python 3 version.
5. **Run on Python 3 in CI** alongside 2 until green; then switch production (canary if possible).
6. **Drop Python 2**: remove `six`/`future` shims and `__future__` imports, run `pyupgrade --py3X-plus`, set `python_requires`.

Each phase: what changes, how it's verified, and how it rolls back. Milestones per phase, then `present_plan`.
