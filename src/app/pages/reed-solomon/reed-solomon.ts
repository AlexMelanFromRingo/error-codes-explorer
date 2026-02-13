import { Component, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';

// GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 = 0x11d
const GF_POLY = 0x11d;
const GF_SIZE = 256;

// Precompute log and exp tables for GF(2^8)
const gfExp: number[] = new Array(512);
const gfLog: number[] = new Array(256);

function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x = x << 1;
    if (x >= GF_SIZE) {
      x = (x ^ GF_POLY) & 0xff;
    }
  }
  for (let i = 255; i < 512; i++) {
    gfExp[i] = gfExp[i - 255];
  }
  gfLog[0] = -1;
}
initGF();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero in GF');
  if (a === 0) return 0;
  return gfExp[(gfLog[a] - gfLog[b] + 255) % 255];
}

function gfPow(x: number, power: number): number {
  return gfExp[(gfLog[x] * power) % 255];
}

function gfInverse(x: number): number {
  return gfExp[255 - gfLog[x]];
}

// Polynomial operations over GF(2^8)
function polyMul(p: number[], q: number[]): number[] {
  const result = new Array(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      result[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return result;
}

function polyEval(p: number[], x: number): number {
  let result = p[0];
  for (let i = 1; i < p.length; i++) {
    result = gfMul(result, x) ^ p[i];
  }
  return result;
}

// Generate RS generator polynomial g(x) = (x - α^0)(x - α^1)...(x - α^(nsym-1))
function rsGeneratorPoly(nsym: number): number[] {
  let g = [1];
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, [1, gfExp[i]]);
  }
  return g;
}

// RS Encode: systematic encoding
function rsEncode(msg: number[], nsym: number): number[] {
  const gen = rsGeneratorPoly(nsym);
  const msgOut = new Array(msg.length + nsym).fill(0);
  for (let i = 0; i < msg.length; i++) {
    msgOut[i] = msg[i];
  }

  for (let i = 0; i < msg.length; i++) {
    const coef = msgOut[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        msgOut[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }

  const result = [...msg];
  for (let i = 0; i < nsym; i++) {
    result.push(msgOut[msg.length + i]);
  }
  return result;
}

// Calculate syndromes
function rsCalcSyndromes(msg: number[], nsym: number): number[] {
  const synd = [0];
  for (let i = 0; i < nsym; i++) {
    synd.push(polyEval(msg, gfExp[i]));
  }
  return synd;
}

// Check if syndromes are all zero
function rsCheckSyndromes(synd: number[]): boolean {
  return synd.slice(1).every(s => s === 0);
}

// Berlekamp-Massey to find error locator polynomial
function rsFindErrorLocator(synd: number[], nsym: number): number[] {
  let errLoc = [1];
  let oldLoc = [1];
  let syndShift = 0;

  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift + 1;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }

    oldLoc.push(0);

    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = oldLoc.map(c => gfMul(c, delta));
        oldLoc = errLoc.map(c => gfMul(c, gfInverse(delta)));
        errLoc = newLoc;
      }

      for (let j = 0; j < oldLoc.length; j++) {
        errLoc[errLoc.length - 1 - j] ^= gfMul(delta, oldLoc[oldLoc.length - 1 - j]);
      }
    }
  }

  // Remove leading zeros
  while (errLoc.length > 0 && errLoc[0] === 0) {
    errLoc.shift();
  }

  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) {
    throw new Error('Too many errors to correct');
  }

  return errLoc;
}

// Find error positions using Chien search
function rsFindErrors(errLoc: number[], msgLen: number): number[] {
  const errs = errLoc.length - 1;
  const errPos: number[] = [];

  for (let i = 0; i < msgLen; i++) {
    if (polyEval(errLoc, gfExp[255 - i]) === 0) {
      errPos.push(msgLen - 1 - i);
    }
  }

  if (errPos.length !== errs) {
    throw new Error('Could not find error positions');
  }

  return errPos;
}

// Forney algorithm for error magnitudes
function rsFindErrorMagnitudes(synd: number[], errLoc: number[], errPos: number[], msgLen: number): number[] {
  const nsym = synd.length - 1;
  const errCount = errPos.length;
  const errMag: number[] = new Array(msgLen).fill(0);

  // Build syndrome polynomial S(x) = S_0 + S_1·x + … + S_{nsym-1}·x^{nsym-1}
  // In code format (highest degree first): [S_{nsym-1}, …, S_1, S_0]
  const syndPoly: number[] = [];
  for (let i = nsym; i >= 1; i--) {
    syndPoly.push(synd[i]);
  }

  // Error evaluator polynomial: Ω(x) = S(x)·Λ(x) mod x^{nsym}
  let omega = polyMul(syndPoly, errLoc);
  if (omega.length > nsym) {
    omega = omega.slice(omega.length - nsym);
  }

  for (let i = 0; i < errCount; i++) {
    const Xi = gfExp[msgLen - 1 - errPos[i]];
    const XiInv = gfInverse(Xi);

    // Evaluate Ω(Xi⁻¹)
    const omegaVal = polyEval(omega, XiInv);

    // Λ'(Xi⁻¹) = Xi · ∏_{j≠i}(1 + Xj·Xi⁻¹), so errLocPrime = ∏_{j≠i}(…)
    let errLocPrime = 1;
    for (let j = 0; j < errCount; j++) {
      if (j !== i) {
        const Xj = gfExp[msgLen - 1 - errPos[j]];
        errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, Xj));
      }
    }
    if (errLocPrime === 0) continue;

    // Forney: e_k = Xi · Ω(Xi⁻¹) / Λ'(Xi⁻¹) = Ω(Xi⁻¹) / errLocPrime
    errMag[errPos[i]] = gfDiv(omegaVal, errLocPrime);
  }

  return errMag;
}


interface RSStep {
  title: string;
  description: string;
  data?: string;
}

@Component({
  selector: 'app-reed-solomon',
  imports: [FormsModule],
  templateUrl: './reed-solomon.html',
  styleUrl: './reed-solomon.scss',
})
export class ReedSolomon {
  // Configuration
  nSymbols = signal(4); // number of error correction symbols (can correct nsym/2 errors)
  messageInput = signal('Hello!');

  // Error injection
  errorPositions = signal<Set<number>>(new Set());

  // Derived: message bytes
  messageBytes = computed(() => {
    const str = this.messageInput();
    return Array.from(str).map(c => c.charCodeAt(0) & 0xff);
  });

  // Generator polynomial
  generatorPoly = computed(() => {
    return rsGeneratorPoly(this.nSymbols());
  });

  // Encoded message
  encoded = computed(() => {
    const msg = this.messageBytes();
    if (msg.length === 0) return [];
    try {
      return rsEncode(msg, this.nSymbols());
    } catch {
      return [];
    }
  });

  // Received (with errors)
  received = computed(() => {
    const enc = [...this.encoded()];
    const errors = this.errorPositions();
    errors.forEach(pos => {
      if (pos < enc.length) {
        enc[pos] = (enc[pos] ^ 0xff) & 0xff; // Flip all bits at error position
      }
    });
    return enc;
  });

  // Syndromes
  syndromes = computed(() => {
    const recv = this.received();
    if (recv.length === 0) return [];
    return rsCalcSyndromes(recv, this.nSymbols());
  });

  // Has errors?
  hasErrors = computed(() => {
    const synd = this.syndromes();
    return synd.length > 1 && !rsCheckSyndromes(synd);
  });

  // Correction result
  correctionResult = computed<{
    success: boolean;
    corrected: number[];
    errorPositions: number[];
    errorMagnitudes: number[];
    message: string;
    steps: RSStep[];
  }>(() => {
    const recv = this.received();
    const synd = this.syndromes();
    const nsym = this.nSymbols();
    const steps: RSStep[] = [];

    if (recv.length === 0) {
      return { success: false, corrected: [], errorPositions: [], errorMagnitudes: [], message: 'Нет данных', steps };
    }

    if (rsCheckSyndromes(synd)) {
      steps.push({ title: 'Проверка синдромов', description: 'Все синдромы равны 0 — ошибок нет', data: synd.slice(1).map(s => s.toString(16).padStart(2, '0')).join(' ') });
      return { success: true, corrected: recv, errorPositions: [], errorMagnitudes: [], message: 'Ошибок не обнаружено', steps };
    }

    steps.push({
      title: 'Синдромы ≠ 0',
      description: `Обнаружены ненулевые синдромы — есть ошибки`,
      data: synd.slice(1).map(s => s.toString(16).padStart(2, '0').toUpperCase()).join(' '),
    });

    try {
      const errLoc = rsFindErrorLocator(synd, nsym);
      steps.push({
        title: 'Полином-локатор ошибок (Берлекэмпа-Мэсси)',
        description: `Коэффициенты: [${errLoc.map(c => c.toString(16).toUpperCase()).join(', ')}]`,
        data: `Степень: ${errLoc.length - 1} → ${errLoc.length - 1} ошибок`,
      });

      const errPos = rsFindErrors(errLoc, recv.length);
      steps.push({
        title: 'Позиции ошибок (поиск Ченя)',
        description: `Найдены корни полинома-локатора`,
        data: `Позиции: [${errPos.join(', ')}]`,
      });

      const errMag = rsFindErrorMagnitudes(synd, errLoc, errPos, recv.length);
      const corrected = [...recv];
      for (const pos of errPos) {
        corrected[pos] ^= errMag[pos];
      }

      steps.push({
        title: 'Величины ошибок (алгоритм Форни)',
        description: errPos.map(p => `Позиция ${p}: величина 0x${errMag[p].toString(16).toUpperCase().padStart(2, '0')}`).join('; '),
        data: 'Исправление: received[pos] XOR magnitude',
      });

      return {
        success: true,
        corrected,
        errorPositions: errPos,
        errorMagnitudes: errMag,
        message: `Исправлено ${errPos.length} ошибок`,
        steps,
      };
    } catch (e: any) {
      steps.push({
        title: 'Ошибка декодирования',
        description: e.message || 'Слишком много ошибок для исправления',
      });
      return { success: false, corrected: recv, errorPositions: [], errorMagnitudes: [], message: e.message || 'Не удалось исправить', steps };
    }
  });

  // Decoded message string
  decodedMessage = computed(() => {
    const result = this.correctionResult();
    if (!result.success) return '(ошибка декодирования)';
    const msgLen = this.messageBytes().length;
    return result.corrected.slice(0, msgLen).map(b => String.fromCharCode(b)).join('');
  });

  // Max correctable errors
  maxErrors = computed(() => Math.floor(this.nSymbols() / 2));

  // GF multiplication table (small 16x16 for display)
  gfMulTable = computed(() => {
    const size = 8;
    const table: number[][] = [];
    for (let i = 0; i < size; i++) {
      const row: number[] = [];
      for (let j = 0; j < size; j++) {
        row.push(gfMul(i, j));
      }
      table.push(row);
    }
    return table;
  });

  // Format byte as hex
  toHex(n: number): string {
    return n.toString(16).toUpperCase().padStart(2, '0');
  }

  // Format polynomial
  formatPoly(coeffs: number[]): string {
    if (coeffs.length === 0) return '0';
    const terms: string[] = [];
    for (let i = 0; i < coeffs.length; i++) {
      const power = coeffs.length - 1 - i;
      const coeff = coeffs[i];
      if (coeff === 0 && coeffs.length > 1) continue;
      let term = '';
      if (power === 0) {
        term = coeff.toString();
      } else if (power === 1) {
        term = coeff === 1 ? 'x' : `${coeff}x`;
      } else {
        term = coeff === 1 ? `x^${power}` : `${coeff}x^${power}`;
      }
      terms.push(term);
    }
    return terms.join(' + ') || '0';
  }

  toggleError(pos: number) {
    const errors = new Set(this.errorPositions());
    if (errors.has(pos)) {
      errors.delete(pos);
    } else {
      if (errors.size < this.maxErrors()) {
        errors.add(pos);
      }
    }
    this.errorPositions.set(errors);
  }

  clearErrors() {
    this.errorPositions.set(new Set());
  }

  randomErrors() {
    const enc = this.encoded();
    if (enc.length === 0) return;
    const max = this.maxErrors();
    const count = Math.min(max, Math.max(1, Math.floor(Math.random() * max) + 1));
    const positions = new Set<number>();
    while (positions.size < count) {
      positions.add(Math.floor(Math.random() * enc.length));
    }
    this.errorPositions.set(positions);
  }

  isErrorPosition(pos: number): boolean {
    return this.errorPositions().has(pos);
  }

  setNSymbols(n: number) {
    this.nSymbols.set(n);
    this.errorPositions.set(new Set());
  }

  onMessageInput(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.messageInput.set(value);
    this.errorPositions.set(new Set());
  }

  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }
}
