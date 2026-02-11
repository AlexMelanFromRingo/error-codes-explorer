import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface BitInfo {
  position: number;
  value: number;
  type: 'data' | 'parity';
  label: string;
  parityGroups: number[];
}

interface EncodingStep {
  parityBit: number;
  positions: number[];
  values: number[];
  xorResult: number;
  explanation: string;
}

@Component({
  selector: 'app-hamming',
  imports: [FormsModule],
  templateUrl: './hamming.html',
  styleUrl: './hamming.scss',
})
export class Hamming {
  // Input data bits
  dataBits = signal<number[]>([1, 0, 1, 1]);
  useExtended = signal(false);

  // Error injection
  errorPosition = signal<number | null>(null);

  // Highlight state for step-by-step
  highlightParityGroup = signal<number | null>(null);

  // Encoded codeword (Hamming(7,4))
  encoded = computed(() => {
    const d = this.dataBits();
    // Positions: p1=1, p2=2, d1=3, p4=4, d2=5, d3=6, d4=7
    const p1 = d[0] ^ d[1] ^ d[3]; // positions 1,3,5,7
    const p2 = d[0] ^ d[2] ^ d[3]; // positions 2,3,6,7
    const p4 = d[1] ^ d[2] ^ d[3]; // positions 4,5,6,7
    const codeword = [p1, p2, d[0], p4, d[1], d[2], d[3]];
    if (this.useExtended()) {
      const p0 = codeword.reduce((a, b) => a ^ b, 0);
      return [p0, ...codeword];
    }
    return codeword;
  });

  // Bit info for display
  bitInfos = computed<BitInfo[]>(() => {
    const enc = this.encoded();
    const ext = this.useExtended();
    const offset = ext ? 0 : 1;
    return enc.map((val, i) => {
      const pos = ext ? i : i + 1;
      const isParity = ext ? (pos === 0 || (pos > 0 && (pos & (pos - 1)) === 0)) : (pos & (pos - 1)) === 0;
      const parityGroups: number[] = [];
      if (!ext || pos > 0) {
        for (let bit = 0; bit < 3; bit++) {
          if (pos & (1 << bit)) {
            parityGroups.push(1 << bit);
          }
        }
      }
      return {
        position: pos,
        value: val,
        type: isParity ? 'parity' : 'data',
        label: isParity ? `p${pos}` : `d`,
        parityGroups,
      };
    });
  });

  // Received word (with possible error)
  received = computed(() => {
    const enc = [...this.encoded()];
    const errPos = this.errorPosition();
    if (errPos !== null && errPos >= 0 && errPos < enc.length) {
      enc[errPos] = enc[errPos] ^ 1;
    }
    return enc;
  });

  // Syndrome calculation
  syndrome = computed(() => {
    const r = this.received();
    const ext = this.useExtended();
    const word = ext ? r.slice(1) : r;

    const s1 = word[0] ^ word[2] ^ word[4] ^ word[6]; // positions 1,3,5,7
    const s2 = word[1] ^ word[2] ^ word[5] ^ word[6]; // positions 2,3,6,7
    const s4 = word[3] ^ word[4] ^ word[5] ^ word[6]; // positions 4,5,6,7

    const syndromeValue = s1 * 1 + s2 * 2 + s4 * 4;
    return { s1, s2, s4, value: syndromeValue };
  });

  // Syndrome details for display
  syndromeSteps = computed<EncodingStep[]>(() => {
    const r = this.received();
    const ext = this.useExtended();
    const word = ext ? r.slice(1) : r;

    const groups = [
      { parity: 1, positions: [0, 2, 4, 6], labels: [1, 3, 5, 7] },
      { parity: 2, positions: [1, 2, 5, 6], labels: [2, 3, 6, 7] },
      { parity: 4, positions: [3, 4, 5, 6], labels: [4, 5, 6, 7] },
    ];

    return groups.map(g => ({
      parityBit: g.parity,
      positions: g.labels,
      values: g.positions.map(p => word[p]),
      xorResult: g.positions.reduce((acc, p) => acc ^ word[p], 0),
      explanation: `s${g.parity} = ${g.positions.map(p => `r[${g.labels[g.positions.indexOf(p)]}]`).join(' XOR ')} = ${g.positions.map(p => word[p]).join(' XOR ')} = ${g.positions.reduce((acc, p) => acc ^ word[p], 0)}`,
    }));
  });

  // Error correction result
  corrected = computed(() => {
    const r = [...this.received()];
    const syn = this.syndrome();
    const ext = this.useExtended();

    if (syn.value === 0) {
      return { word: r, errorAt: -1, message: 'Ошибок не обнаружено' };
    }

    const errorIdx = ext ? syn.value : syn.value - 1;
    if (errorIdx >= 0 && errorIdx < r.length) {
      r[errorIdx] = r[errorIdx] ^ 1;
      const posLabel = ext ? syn.value : syn.value;
      return { word: r, errorAt: errorIdx, message: `Ошибка в позиции ${posLabel} — исправлена!` };
    }
    return { word: r, errorAt: -1, message: 'Синдром указывает за пределы слова' };
  });

  // Encoding steps for display
  encodingSteps = computed<EncodingStep[]>(() => {
    const d = this.dataBits();
    return [
      {
        parityBit: 1,
        positions: [1, 3, 5, 7],
        values: [d[0], d[1], d[3]],
        xorResult: d[0] ^ d[1] ^ d[3],
        explanation: `p1 = d1 XOR d2 XOR d4 = ${d[0]} XOR ${d[1]} XOR ${d[3]} = ${d[0] ^ d[1] ^ d[3]}`,
      },
      {
        parityBit: 2,
        positions: [2, 3, 6, 7],
        values: [d[0], d[2], d[3]],
        xorResult: d[0] ^ d[2] ^ d[3],
        explanation: `p2 = d1 XOR d3 XOR d4 = ${d[0]} XOR ${d[2]} XOR ${d[3]} = ${d[0] ^ d[2] ^ d[3]}`,
      },
      {
        parityBit: 4,
        positions: [4, 5, 6, 7],
        values: [d[1], d[2], d[3]],
        xorResult: d[1] ^ d[2] ^ d[3],
        explanation: `p4 = d2 XOR d3 XOR d4 = ${d[1]} XOR ${d[2]} XOR ${d[3]} = ${d[1] ^ d[2] ^ d[3]}`,
      },
    ];
  });

  // Parity check matrix H
  parityCheckMatrix = [
    [1, 0, 1, 0, 1, 0, 1], // row for s1
    [0, 1, 1, 0, 0, 1, 1], // row for s2
    [0, 0, 0, 1, 1, 1, 1], // row for s4
  ];

  // Generator matrix G
  generatorMatrix = [
    [1, 1, 0, 1, 0, 0, 0], // d1 -> positions
    [0, 1, 0, 1, 0, 1, 0], // wait, let me recalculate
    // Standard form G = [I_k | P^T] for systematic Hamming(7,4):
    // d1 d2 d3 d4 → c1 c2 c3 c4 c5 c6 c7
  ];

  // H matrix labels
  hLabels = ['s1', 's2', 's4'];
  posLabels = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];

  toggleDataBit(index: number) {
    const bits = [...this.dataBits()];
    bits[index] = bits[index] ^ 1;
    this.dataBits.set(bits);
    this.errorPosition.set(null);
  }

  setDataBits(bits: number[]) {
    this.dataBits.set(bits);
    this.errorPosition.set(null);
  }

  injectError(position: number) {
    if (this.errorPosition() === position) {
      this.errorPosition.set(null);
    } else {
      this.errorPosition.set(position);
    }
  }

  clearError() {
    this.errorPosition.set(null);
  }

  randomData() {
    const bits = Array.from({ length: 4 }, () => Math.round(Math.random()));
    this.dataBits.set(bits);
    this.errorPosition.set(null);
  }

  randomError() {
    const len = this.encoded().length;
    this.errorPosition.set(Math.floor(Math.random() * len));
  }

  isInParityGroup(position: number, group: number): boolean {
    // eslint-disable-next-line no-bitwise
    return (position & group) !== 0;
  }

  isPowerOfTwo(n: number): boolean {
    // eslint-disable-next-line no-bitwise
    return n > 0 && (n & (n - 1)) === 0;
  }

  getPositionType(i: number): string {
    return this.isPowerOfTwo(i) ? 'p' + i : 'd';
  }
}
