The false zero #4757's body carried, as #4771 names it. Measured on
`origin/dev` @ `49747fac3`.

## Method

```bash
git grep -l -e 'import' 49747fac3 -- 'packages/*/src'                        # control: reach
git grep -c -w -E -e 'TODO|FIXME|HACK|XXX' 49747fac3 -- 'packages/*/src'     # check: lines = 0; control: reach
```
