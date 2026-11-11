## Method

```bash
git grep -c -e 'import' 249c77ca0 -- packages            # check: lines = 3
git grep -l -e 'import' 249c77ca0 -- packages            # check: files = 1
git grep -c -w -e 'TODO' 249c77ca0 -- packages           # check: lines = 0; control: nope
git show 249c77ca0:docs/notes.md                         # check: lines 3-5 contain 'bash -c'
git show 249c77ca0:docs/notes.md                         # check: lines 1-9 contain 'bash -c'
git show 249c77ca0:docs/notes.md                         # check: line 1 contains 'no such text'
git show 249c77ca0:docs/missing.md                       # check: line 1 contains 'line one'
git ls-tree 249c77ca0 -- packages/a/src/gone.ts          # check: exists
git ls-tree 249c77ca0 -- packages/a/src/index.ts         # check: absent
```
