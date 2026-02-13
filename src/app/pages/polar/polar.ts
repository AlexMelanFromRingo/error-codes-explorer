import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';

// Polar code implementation for N=8
// Kronecker product F^⊗n where F = [[1,0],[1,1]]

function kronecker(a: number[][], b: number[][]): number[][] {
  const am = a.length, an = a[0].length;
  const bm = b.length, bn = b[0].length;
  const result: number[][] = [];
  for (let i = 0; i < am * bm; i++) {
    result[i] = [];
    for (let j = 0; j < an * bn; j++) {
      result[i][j] = a[Math.floor(i / bm)][Math.floor(j / bn)] * b[i % bm][j % bn];
    }
  }
  return result;
}

function generateG(n: number): number[][] {
  const F = [[1, 0], [1, 1]];
  let G = F;
  for (let i = 1; i < n; i++) {
    G = kronecker(G, F);
  }
  // Apply mod 2
  return G.map(row => row.map(v => v % 2));
}

// Compute Bhattacharyya parameters for BEC with erasure probability eps
function bhattacharyya(n: number, eps: number): number[] {
  if (n === 1) return [eps];
  const half = bhattacharyya(n / 2, eps);
  const result: number[] = [];
  for (let i = 0; i < half.length; i++) {
    result.push(Math.min(2 * half[i] - half[i] * half[i], 1)); // W- (bad)
    result.push(half[i] * half[i]); // W+ (good)
  }
  return result;
}

// Bit-reversal permutation
function bitReverse(x: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (x & 1);
    x >>= 1;
  }
  return result;
}

// Successive Cancellation decoding
function scDecode(received: number[], frozenBits: Set<number>, N: number): number[] {
  const decoded: number[] = new Array(N).fill(0);
  const reliability = 2.0;

  function f(a: number, b: number): number {
    const sign = (a >= 0 ? 1 : -1) * (b >= 0 ? 1 : -1);
    return sign * Math.min(Math.abs(a), Math.abs(b));
  }

  function g(a: number, b: number, u: number): number {
    return b + (1 - 2 * u) * a;
  }

  // Recursive SC decoder — returns encoded partial sums for parent's g-function
  function decode(llr: number[], offset: number, size: number): number[] {
    if (size === 1) {
      decoded[offset] = frozenBits.has(offset) ? 0 : (llr[0] < 0 ? 1 : 0);
      return [decoded[offset]];
    }

    const half = size / 2;

    // f-values for upper sub-decoder
    const fLlr: number[] = new Array(half);
    for (let i = 0; i < half; i++) {
      fLlr[i] = f(llr[i], llr[half + i]);
    }
    const upperEnc = decode(fLlr, offset, half);

    // g-values for lower sub-decoder (using encoded partial sums, not raw decoded bits)
    const gLlr: number[] = new Array(half);
    for (let i = 0; i < half; i++) {
      gLlr[i] = g(llr[i], llr[half + i], upperEnc[i]);
    }
    const lowerEnc = decode(gLlr, offset + half, half);

    // Combine: butterfly output = [upper XOR lower, lower]
    const combined: number[] = new Array(size);
    for (let i = 0; i < half; i++) {
      combined[i] = upperEnc[i] ^ lowerEnc[i];
      combined[half + i] = lowerEnc[i];
    }
    return combined;
  }

  const initialLlr = received.map(bit => bit === 0 ? reliability : -reliability);
  decode(initialLlr, 0, N);
  return decoded;
}


interface PolarChannel {
  index: number;
  bhattacharyya: number;
  type: 'frozen' | 'info';
  reliability: number;
}

@Component({
  selector: 'app-polar',
  imports: [FormsModule],
  templateUrl: './polar.html',
  styleUrl: './polar.scss',
})
export class Polar {
  // Code parameters
  N = signal(8); // Block length (must be power of 2)
  K = signal(4); // Information bits
  erasureProb = signal(0.5);

  // Data bits
  infoBits = signal<number[]>([1, 0, 1, 1]);

  // Error injection
  errorPositions = signal<Set<number>>(new Set());

  // n = log2(N)
  logN = computed(() => Math.log2(this.N()));

  // Bhattacharyya parameters
  bhattacharyyaParams = computed(() => {
    return bhattacharyya(this.N(), this.erasureProb());
  });

  // Channels sorted by reliability
  channels = computed<PolarChannel[]>(() => {
    const params = this.bhattacharyyaParams();
    const K = this.K();
    const N = this.N();

    // Sort indices by Bhattacharyya parameter (ascending = more reliable)
    const sorted = params.map((z, i) => ({ index: i, z }))
      .sort((a, b) => a.z - b.z);

    // Best K channels are info, rest are frozen
    const infoSet = new Set(sorted.slice(0, K).map(c => c.index));

    return params.map((z, i) => ({
      index: i,
      bhattacharyya: z,
      type: infoSet.has(i) ? 'info' : 'frozen',
      reliability: 1 - z,
    }));
  });

  // Frozen bit set
  frozenBits = computed(() => {
    return new Set(this.channels().filter(c => c.type === 'frozen').map(c => c.index));
  });

  // Info bit indices (sorted)
  infoBitIndices = computed(() => {
    return this.channels().filter(c => c.type === 'info').map(c => c.index).sort((a, b) => a - b);
  });

  // Frozen bit indices (sorted)
  frozenBitIndices = computed(() => {
    return this.channels().filter(c => c.type === 'frozen').map(c => c.index).sort((a, b) => a - b);
  });

  // Generator matrix G_N
  generatorMatrix = computed(() => {
    return generateG(this.logN());
  });

  // Input vector u (frozen + info bits)
  inputVector = computed(() => {
    const u = new Array(this.N()).fill(0);
    const infoIndices = this.infoBitIndices();
    const data = this.infoBits();
    for (let i = 0; i < Math.min(infoIndices.length, data.length); i++) {
      u[infoIndices[i]] = data[i];
    }
    return u;
  });

  // Encoded codeword: x = u * G_N (mod 2)
  encoded = computed(() => {
    const u = this.inputVector();
    const G = this.generatorMatrix();
    const N = this.N();
    const x: number[] = new Array(N).fill(0);
    for (let j = 0; j < N; j++) {
      let sum = 0;
      for (let i = 0; i < N; i++) {
        sum += u[i] * G[i][j];
      }
      x[j] = sum % 2;
    }
    return x;
  });

  // Received word
  received = computed(() => {
    const x = [...this.encoded()];
    this.errorPositions().forEach(pos => {
      if (pos < x.length) x[pos] = 1 - x[pos];
    });
    return x;
  });

  // SC Decoding result
  decoded = computed(() => {
    const recv = this.received();
    const frozen = this.frozenBits();
    const N = this.N();
    return scDecode(recv, frozen, N);
  });

  // Extracted info bits after decoding
  decodedInfoBits = computed(() => {
    const dec = this.decoded();
    return this.infoBitIndices().map(i => dec[i]);
  });

  // Decoding success
  decodingSuccess = computed(() => {
    const original = this.infoBits();
    const decoded = this.decodedInfoBits();
    return original.every((b, i) => b === (decoded[i] ?? 0));
  });

  // Butterfly diagram stages
  butterflyStages = computed(() => {
    const n = this.logN();
    const N = this.N();
    const stages: { pairs: { top: number; bottom: number }[] }[] = [];

    for (let s = 0; s < n; s++) {
      const blockSize = 1 << (s + 1);
      const halfBlock = blockSize / 2;
      const pairs: { top: number; bottom: number }[] = [];

      for (let block = 0; block < N; block += blockSize) {
        for (let i = 0; i < halfBlock; i++) {
          pairs.push({ top: block + i, bottom: block + i + halfBlock });
        }
      }
      stages.push({ pairs });
    }
    return stages;
  });

  toggleInfoBit(idx: number) {
    const bits = [...this.infoBits()];
    if (idx < bits.length) {
      bits[idx] = 1 - bits[idx];
      this.infoBits.set(bits);
      this.errorPositions.set(new Set());
    }
  }

  randomInfoBits() {
    const K = this.K();
    this.infoBits.set(Array.from({ length: K }, () => Math.round(Math.random())));
    this.errorPositions.set(new Set());
  }

  toggleError(pos: number) {
    const errors = new Set(this.errorPositions());
    if (errors.has(pos)) errors.delete(pos);
    else errors.add(pos);
    this.errorPositions.set(errors);
  }

  clearErrors() { this.errorPositions.set(new Set()); }

  randomError() {
    const N = this.N();
    this.errorPositions.set(new Set([Math.floor(Math.random() * N)]));
  }

  isError(pos: number): boolean { return this.errorPositions().has(pos); }

  range(n: number): number[] { return Array.from({ length: n }, (_, i) => i); }
}
