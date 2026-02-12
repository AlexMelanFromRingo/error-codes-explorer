import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';

// Small LDPC parity-check matrix H for demonstration
// This is a regular (3,6) LDPC code: 6 variable nodes, 3 check nodes
// Each check node connects to exactly 4 variable nodes
// Each variable node connects to exactly 2 check nodes
const DEFAULT_H: number[][] = [
  [1, 1, 0, 1, 1, 0],
  [0, 1, 1, 0, 1, 1],
  [1, 0, 1, 1, 0, 1],
];

interface TannerNode {
  id: string;
  type: 'variable' | 'check';
  label: string;
  x: number;
  y: number;
  value?: number;
}

interface TannerEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  message?: number;
}

interface BPIteration {
  iteration: number;
  checkToVar: number[][];  // messages from check to variable
  varToCheck: number[][];  // messages from variable to check
  beliefs: number[];       // LLR beliefs at each variable node
  decoded: number[];       // hard decision
  syndromeOk: boolean;     // syndrome check passes?
}

@Component({
  selector: 'app-ldpc',
  imports: [FormsModule],
  templateUrl: './ldpc.html',
  styleUrl: './ldpc.scss',
})
export class Ldpc {
  // Parity-check matrix
  hMatrix = signal<number[][]>(DEFAULT_H.map(r => [...r]));

  // Original codeword (all-zero is always a valid codeword for linear codes)
  codeword = signal<number[]>([0, 0, 0, 0, 0, 0]);

  // Channel noise: flip probability
  flipProb = signal(0.15);

  // Error positions
  errorPositions = signal<Set<number>>(new Set());

  // Max BP iterations
  maxIterations = signal(10);

  // Matrix dimensions
  numCheckNodes = computed(() => this.hMatrix().length);
  numVarNodes = computed(() => this.hMatrix()[0]?.length || 0);

  // Code rate
  codeRate = computed(() => {
    const n = this.numVarNodes();
    const m = this.numCheckNodes();
    return n > 0 ? ((n - m) / n) : 0;
  });

  // Sparsity
  sparsity = computed(() => {
    const h = this.hMatrix();
    const total = h.length * (h[0]?.length || 0);
    const ones = h.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
    return total > 0 ? (1 - ones / total) : 0;
  });

  // Row/column weights
  rowWeights = computed(() => this.hMatrix().map(row => row.reduce((s, v) => s + v, 0)));
  colWeights = computed(() => {
    const h = this.hMatrix();
    if (h.length === 0) return [];
    return h[0].map((_, j) => h.reduce((s, row) => s + row[j], 0));
  });

  // Received word (with errors)
  received = computed(() => {
    const cw = [...this.codeword()];
    this.errorPositions().forEach(pos => {
      if (pos < cw.length) cw[pos] = 1 - cw[pos];
    });
    return cw;
  });

  // Channel LLRs (log-likelihood ratios)
  channelLLR = computed(() => {
    const r = this.received();
    const p = this.flipProb();
    const llr0 = Math.log((1 - p) / p); // LLR for received 0
    const llr1 = -llr0; // LLR for received 1
    return r.map(bit => bit === 0 ? llr0 : llr1);
  });

  // Tanner graph nodes
  tannerNodes = computed<TannerNode[]>(() => {
    const n = this.numVarNodes();
    const m = this.numCheckNodes();
    const nodes: TannerNode[] = [];

    const svgW = 600;
    const margin = 60;

    // Variable nodes at top
    for (let j = 0; j < n; j++) {
      nodes.push({
        id: `v${j}`,
        type: 'variable',
        label: `v${j}`,
        x: margin + j * ((svgW - 2 * margin) / Math.max(n - 1, 1)),
        y: 40,
        value: this.received()[j],
      });
    }

    // Check nodes at bottom
    for (let i = 0; i < m; i++) {
      nodes.push({
        id: `c${i}`,
        type: 'check',
        label: `c${i}`,
        x: margin + i * ((svgW - 2 * margin) / Math.max(m - 1, 1)) + ((svgW - 2 * margin) / (2 * Math.max(m - 1, 1))),
        y: 160,
      });
    }

    return nodes;
  });

  // Tanner graph edges
  tannerEdges = computed<TannerEdge[]>(() => {
    const h = this.hMatrix();
    const nodes = this.tannerNodes();
    const edges: TannerEdge[] = [];
    const n = this.numVarNodes();

    for (let i = 0; i < h.length; i++) {
      for (let j = 0; j < h[i].length; j++) {
        if (h[i][j] === 1) {
          const vNode = nodes.find(nd => nd.id === `v${j}`)!;
          const cNode = nodes.find(nd => nd.id === `c${i}`)!;
          edges.push({
            from: `v${j}`,
            to: `c${i}`,
            x1: vNode.x,
            y1: vNode.y + 16,
            x2: cNode.x,
            y2: cNode.y - 16,
          });
        }
      }
    }
    return edges;
  });

  // Run Belief Propagation
  bpIterations = computed<BPIteration[]>(() => {
    const h = this.hMatrix();
    const m = h.length;
    const n = h[0]?.length || 0;
    const channelLlr = this.channelLLR();
    const maxIter = this.maxIterations();
    const iterations: BPIteration[] = [];

    // Initialize variable-to-check messages with channel LLRs
    let varToCheck: number[][] = [];
    for (let i = 0; i < m; i++) {
      varToCheck[i] = [];
      for (let j = 0; j < n; j++) {
        varToCheck[i][j] = h[i][j] === 1 ? channelLlr[j] : 0;
      }
    }

    for (let iter = 0; iter < maxIter; iter++) {
      // Check-to-variable messages (min-sum approximation)
      const checkToVar: number[][] = [];
      for (let i = 0; i < m; i++) {
        checkToVar[i] = [];
        for (let j = 0; j < n; j++) {
          if (h[i][j] === 0) { checkToVar[i][j] = 0; continue; }

          let sign = 1;
          let minAbs = Infinity;
          for (let jj = 0; jj < n; jj++) {
            if (jj === j || h[i][jj] === 0) continue;
            const msg = varToCheck[i][jj];
            sign *= msg >= 0 ? 1 : -1;
            minAbs = Math.min(minAbs, Math.abs(msg));
          }
          checkToVar[i][j] = sign * minAbs * 0.75; // scaling factor for better convergence
        }
      }

      // Variable-to-check messages
      const newVarToCheck: number[][] = [];
      const beliefs: number[] = [];

      for (let j = 0; j < n; j++) {
        let totalLlr = channelLlr[j];
        for (let i = 0; i < m; i++) {
          if (h[i][j] === 1) totalLlr += checkToVar[i][j];
        }
        beliefs[j] = totalLlr;
      }

      for (let i = 0; i < m; i++) {
        newVarToCheck[i] = [];
        for (let j = 0; j < n; j++) {
          if (h[i][j] === 0) { newVarToCheck[i][j] = 0; continue; }
          newVarToCheck[i][j] = beliefs[j] - checkToVar[i][j];
        }
      }

      // Hard decision
      const decoded = beliefs.map(b => b < 0 ? 1 : 0);

      // Syndrome check
      let syndromeOk = true;
      for (let i = 0; i < m; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) {
          if (h[i][j] === 1) s ^= decoded[j];
        }
        if (s !== 0) { syndromeOk = false; break; }
      }

      iterations.push({
        iteration: iter + 1,
        checkToVar: checkToVar.map(r => [...r]),
        varToCheck: newVarToCheck.map(r => [...r]),
        beliefs: [...beliefs],
        decoded: [...decoded],
        syndromeOk,
      });

      varToCheck = newVarToCheck;

      if (syndromeOk) break;
    }

    return iterations;
  });

  // Final result
  finalResult = computed(() => {
    const iters = this.bpIterations();
    if (iters.length === 0) return { decoded: this.received(), converged: false, iterations: 0 };
    const last = iters[iters.length - 1];
    return { decoded: last.decoded, converged: last.syndromeOk, iterations: iters.length };
  });

  // Active iteration for visualization
  activeIteration = signal(0);

  toggleError(pos: number) {
    const errors = new Set(this.errorPositions());
    if (errors.has(pos)) errors.delete(pos);
    else errors.add(pos);
    this.errorPositions.set(errors);
    this.activeIteration.set(0);
  }

  clearErrors() {
    this.errorPositions.set(new Set());
    this.activeIteration.set(0);
  }

  randomErrors() {
    const n = this.numVarNodes();
    const p = this.flipProb();
    const errors = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (Math.random() < p) errors.add(i);
    }
    if (errors.size === 0 && n > 0) errors.add(Math.floor(Math.random() * n));
    this.errorPositions.set(errors);
    this.activeIteration.set(0);
  }

  isError(pos: number): boolean {
    return this.errorPositions().has(pos);
  }

  toggleMatrixCell(i: number, j: number) {
    const h = this.hMatrix().map(r => [...r]);
    h[i][j] = 1 - h[i][j];
    this.hMatrix.set(h);
    this.errorPositions.set(new Set());
  }

  setActiveIteration(iter: number) {
    this.activeIteration.set(iter);
  }

  formatLLR(val: number): string {
    return val.toFixed(2);
  }

  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }

  abs(n: number): number {
    return Math.abs(n);
  }
}
