// Compares two Wasm modules (as read by wasm-sections.mjs) and says, from what is recorded in them, how they
// differ. Pure: no files, no network.
//
// It only reports what the two modules show. The one thing it infers is the cause of a difference when the
// evidence is plain: a different recorded compiler or SDK, a `cliver` entry on one side only (the Stellar CLI
// adds it when it optimizes a file), or identical recorded toolchains with different code.
import { metaValue, sectionLabel } from './wasm-sections.mjs';

const TOOLCHAIN_KEYS = [
  ['compiler', 'rsver'],
  ['sdk', 'rssdkver'],
  ['cli', 'cliver'],
];

/** Sections by label, in file order: { 'code': [{ size, digest }], 'custom contractmetav0': [{...}, {...}] }. */
function sectionsByLabel(info) {
  const map = new Map();
  for (const section of info.sections) {
    const label = sectionLabel(section);
    map.set(label, [...(map.get(label) ?? []), { size: section.size, digest: section.digest }]);
  }
  return map;
}

/** A list of sections as one string that is equal exactly when the sizes and the contents are. */
const identity = (list) => list.map((s) => `${s.size}:${s.digest}`).join(',');

/**
 * How two modules differ:
 *   { sameHash, sizes: [a, b], toolchain: [{ what, a, b }], interface: { a, b } | null,
 *     sections: { differ: [{ label, a, b, sameSizes }], onlyA: [label], onlyB: [label] } }
 * A section differs when its content does, even if its size is the same (`sameSizes`); `a` and `b` are sizes.
 * `toolchain` lists the compiler, SDK and CLI entries that are not equal (a missing entry is undefined).
 */
export function diff(a, b) {
  const toolchain = [];
  for (const [what, key] of TOOLCHAIN_KEYS) {
    const [va, vb] = [metaValue(a, key), metaValue(b, key)];
    if (va !== vb) toolchain.push({ what, a: va, b: vb });
  }
  const ia = a.interface?.protocol;
  const ib = b.interface?.protocol;

  const [sa, sb] = [sectionsByLabel(a), sectionsByLabel(b)];
  const differ = [];
  for (const [label, listA] of sa) {
    const listB = sb.get(label);
    if (listB === undefined || identity(listA) === identity(listB)) continue;
    const [sizesA, sizesB] = [listA.map((s) => s.size), listB.map((s) => s.size)];
    differ.push({ label, a: sizesA, b: sizesB, sameSizes: sizesA.join(',') === sizesB.join(',') });
  }
  return {
    sameHash: a.sha256 === b.sha256,
    sizes: [a.size, b.size],
    toolchain,
    interface: ia === ib ? null : { a: ia, b: ib },
    sections: {
      differ,
      onlyA: [...sa.keys()].filter((label) => !sb.has(label)),
      onlyB: [...sb.keys()].filter((label) => !sa.has(label)),
    },
  };
}

const shown = (value) => (value === undefined ? '(none)' : value);

/** What the differences amount to, in plain words, drawn only from the data in `d`. Returns an array of lines. */
export function explain(d) {
  if (d.sameHash) return ['The two are the same Wasm: identical bytes, identical hash.'];

  const lines = [];
  const recordedDifference = d.toolchain.filter((t) => t.what !== 'cli');
  const cli = d.toolchain.find((t) => t.what === 'cli');
  const codeDiffers = d.sections.differ.some((s) => s.label === 'code');

  if (recordedDifference.length > 0 || d.interface !== null) {
    lines.push('They were built with different tools: ' + [...recordedDifference.map((t) => t.what), ...(d.interface ? ['interface version'] : [])].join(' and ') + ' differ.');
  }
  if (cli !== undefined && (cli.a === undefined) !== (cli.b === undefined)) {
    const processed = cli.a === undefined ? 'B' : 'A';
    lines.push(`Only ${processed} carries a cliver entry, so only ${processed} was processed by the Stellar CLI${codeDiffers ? ', and its code section differs' : ''}.`);
  }
  if (lines.length === 0 && codeDiffers) {
    lines.push('The recorded tools are the same but the code differs, so the source (or an unrecorded build setting) is different.');
  }
  if (lines.length === 0 && (d.sections.differ.length > 0 || d.sections.onlyA.length > 0 || d.sections.onlyB.length > 0)) {
    lines.push('They differ in sections other than the code (listed above), and nothing recorded says why.');
  }
  if (lines.length === 0) {
    lines.push('The hashes differ but every section is the same: the difference is in the header or the order of the sections.');
  }
  return lines;
}

/** The lines of a comparison: the names, then each difference, then what it amounts to. */
export function compareReport(nameA, nameB, a, b) {
  const d = diff(a, b);
  const lines = [`A  ${nameA}`, `B  ${nameB}`, `hash      ${d.sameHash ? 'same' : 'different'}`];
  lines.push(`size      ${d.sizes[0] === d.sizes[1] ? `same (${d.sizes[0]} bytes)` : `A ${d.sizes[0]} bytes, B ${d.sizes[1]} bytes`}`);
  for (const [what, key] of TOOLCHAIN_KEYS) {
    const t = d.toolchain.find((entry) => entry.what === what);
    // When nothing differs the two sides are equal, so A's value is B's too.
    const value = metaValue(a, key);
    lines.push(`${what.padEnd(9)} ${t === undefined ? `same (${value === undefined ? 'none' : value})` : `A ${shown(t.a)}, B ${shown(t.b)}`}`);
  }
  lines.push(`interface ${d.interface === null ? 'same' : `A protocol ${shown(d.interface.a)}, B protocol ${shown(d.interface.b)}`}`);
  for (const s of d.sections.differ) {
    const how = s.sameSizes ? `same size (${s.a.join('+')}), different content` : `A ${s.a.join('+')}, B ${s.b.join('+')}`;
    lines.push(`section   ${s.label}: ${how}`);
  }
  if (d.sections.onlyA.length > 0) lines.push(`only in A ${d.sections.onlyA.join(', ')}`);
  if (d.sections.onlyB.length > 0) lines.push(`only in B ${d.sections.onlyB.join(', ')}`);
  lines.push('', ...explain(d));
  return lines;
}
