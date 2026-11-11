## Method

```bash
git grep -l -e 'import' 249c77ca0 -- docs                # control: empty
git grep -l -e 'import' 249c77ca0 -- packages            # control: elsewhere
git grep -l -e 'side' 8d170cd8c -- side.txt              # control: offbranch
git grep -c -e 'FIXME' 249c77ca0 -- 'packages/*/src/**'  # check: lines = 0
git grep -c -e 'FIXME' 249c77ca0 -- 'packages/*/src/**'  # check: lines = 0; control: missing
git grep -c -e 'FIXME' 249c77ca0 -- docs                 # check: lines = 0; control: empty
git grep -c -e 'FIXME' 249c77ca0 -- 'packages/*/src/**'  # check: lines = 0; control: elsewhere
git grep -c -e 'FIXME' 249c77ca0 -- side.txt             # check: lines = 0; control: offbranch
git ls-tree 249c77ca0 -- packages/a/scr/index.ts         # check: absent
```
