Part of a fixture. Measured on the fixture repository @ `249c77ca0`.

## Scope

A body whose every checkable line reproduces.

## Method

```bash
SHA=249c77ca0   # free-form: an assignment line is not checkable
git log --oneline ${SHA} | head -3                      # free-form, never run
git grep -c -e 'import' 249c77ca0 -- packages            # check: lines = 2
git grep -l -e 'import' 249c77ca0 -- packages            # check: files = 2  # one per package
git grep -c -e 'line' 249c77ca0 -- docs                  # check: lines = 5
git grep -l -e 'line' 249c77ca0 -- docs                  # check: files = 1
git grep -l -e 'import' 249c77ca0 -- 'packages/*/src/**' # control: reach
git grep -c -w -E -e 'FIXME|HACK|XXX' 249c77ca0 -- 'packages/*/src/**'   # check: lines = 0; control: reach
git grep -c -i -F -e 'todo LATER' 249c77ca0 -- packages ':!packages/b'   # check: lines = 1
git show 249c77ca0:docs/notes.md                         # check: lines 1-3 contain 'bash -c'
git show 249c77ca0:docs/notes.md                         # check: line 5 contains "line five"
git ls-tree 249c77ca0 -- packages/a/src/index.ts         # check: exists
git ls-tree 249c77ca0 -- packages/a/src/gone.ts          # check: absent
git ls-tree 249c77ca0 -- side.txt                        # check: absent
```

## After

```bash
git grep -c -e 'import' 249c77ca0 -- packages            # check: lines = 99
```
