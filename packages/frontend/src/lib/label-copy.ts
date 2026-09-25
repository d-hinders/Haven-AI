/**
 * Label copy (#3167) — the single sentences two surfaces say identically.
 *
 * Extracted per the #2195/#2230 pattern: the agents list, the editor and the
 * manager render the same facts, and a divergence between screens one click
 * apart is the defect class those fixes retired. The file is named
 * `*-copy.ts` so `lint:copy` scans it (#2333).
 */

/** Editor helper: what tagging an agent does, next to the checkbox list. */
export const LABEL_EDITOR_NOTE =
  'Labels are for organising your list only. They never change what an agent can spend.'

/** Manager delete confirm: the promise the ConfirmDialog body keeps. */
export const LABEL_DELETE_BODY =
  'Agents carrying this label keep everything else. Only the label and its tags on agents are removed.'
