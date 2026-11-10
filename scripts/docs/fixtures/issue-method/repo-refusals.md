Every checkable line here must be refused, and none may reach git or a shell.

## Method

```bash
git grep -c -e '-x' 249c77ca0 -- packages                         # check: lines = 1
git grep -c -e 'import' 249c77ca0 -- '--output=CANARY'            # check: lines = 1
git ls-tree 249c77ca0 -- '-r'                                     # check: exists
git ls-tree 249c77ca0 -- /etc/passwd                              # check: exists
git show 249c77ca0:/etc/passwd                                    # check: line 1 contains 'root'
git show 249c77ca0:docs/../docs/notes.md                          # check: line 1 contains 'line one'
git grep -c -e 'import' 249c77ca0 -- '../outside'                 # check: lines = 1
git grep -c -e 'import' 249c77ca0 -- ':(top)packages'             # check: lines = 2
git grep -c -e 'import' HEAD -- packages                          # check: lines = 2
git grep -c -e 'import' origin/dev -- packages                    # check: lines = 2
git grep -c -e 'import' 249C77CA0 -- packages                     # check: lines = 2
git grep -c -e 'import' 249c7 -- packages                         # check: lines = 2
git grep -c -e 'import' 8d170cd8c -- packages                     # check: lines = 2
git grep -c -e 'import' 0123456789abcdef -- packages              # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages | wc -l             # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages > CANARY            # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages < CANARY            # check: lines = 2
git grep -c -e "$(touch CANARY)" 249c77ca0 -- packages            # check: lines = 2
git grep -c -e `touch CANARY` 249c77ca0 -- packages               # check: lines = 2
git grep -c -e 'import' ${SHA} -- packages                        # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages; touch CANARY       # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages && touch CANARY     # check: lines = 2
GIT_DIR=/tmp git grep -c -e 'import' 249c77ca0 -- packages        # check: lines = 2
rg -c 'import' packages                                           # check: lines = 2
node -e 'require("fs").writeFileSync("CANARY","x")'               # check: lines = 2
touch CANARY                                                      # check: exists
git log --oneline 249c77ca0                                       # check: lines = 2
git -c core.pager='touch CANARY' grep -c -e 'import' 249c77ca0 -- packages   # check: lines = 2
git grep --output=CANARY -c -e 'import' 249c77ca0 -- packages     # check: lines = 2
git show --output=CANARY 249c77ca0:docs/notes.md                  # check: line 1 contains 'line one'
git show --ext-diff 249c77ca0:docs/notes.md                       # check: line 1 contains 'line one'
git grep -O'touch CANARY' -c -e 'import' 249c77ca0 -- packages    # check: lines = 2
git grep --open-files-in-pager='touch CANARY' -e 'import' 249c77ca0 -- packages   # check: files = 2
git grep -c 'import' 249c77ca0 -- packages                        # check: lines = 2
git grep -c -l -e 'import' 249c77ca0 -- packages                  # check: lines = 2
git grep -c -e 'import' 249c77ca0 -- packages/*                   # check: lines = 2
git grep -c -e imp\ort 249c77ca0 -- packages                      # check: lines = 2
git grep -l -e 'import' 249c77ca0 -- packages                     # check: lines = 2
git ls-tree 249c77ca0 -- packages                                 # check: lines = 2
git ls-tree -r 249c77ca0 -- packages                              # check: exists
git show 249c77ca0:docs/notes.md                                  # check: lines 3-1 contain 'line'
git show 249c77ca0:docs/notes.md                                  # check: line 1 contains line
git grep -c -e 'import' 249c77ca0 -- packages                     # check: lines = two
git grep -c -e ' # check: lines = 2' 249c77ca0 -- packages
```
