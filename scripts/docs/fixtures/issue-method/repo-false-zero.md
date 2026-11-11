Part of a fixture. Measured on the fixture repository @ `249c77ca0`.

## Method

The pathspec `packages/*/src` matches no file, so the zero and its control are
both zero and the zero proves nothing (#4757's body carried this).

```bash
git grep -l -e 'import' 249c77ca0 -- 'packages/*/src'                        # control: reach
git grep -c -w -E -e 'TODO|FIXME|HACK|XXX' 249c77ca0 -- 'packages/*/src'     # check: lines = 0; control: reach
```
