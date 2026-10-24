/**
 * A minimal terminal screen for reading what a full-screen TUI has drawn.
 *
 * A differential renderer such as OpenTUI repaints only the cells that
 * changed since its last frame and moves the cursor between them. A phrase
 * that is visible on screen is therefore often absent from the raw byte
 * stream: when a dialog title changes only in its last digit, just that
 * digit is written. Searching the bytes for the phrase misses it; this
 * screen applies the cursor moves and reads the phrase from the cells.
 *
 * It understands what such a renderer emits: printable text, cursor
 * positioning and movement, erasing, line feeds and scrolling. Colors,
 * modes and other control sequences are consumed and ignored.
 */
export class TerminalScreen {
  readonly cols: number
  readonly rows: number
  private cells: string[][]
  private row = 0
  private col = 0
  private saved = { row: 0, col: 0 }
  private readonly decoder = new TextDecoder()
  /** Escape sequence bytes not yet complete at the end of the last write. */
  private pending = ''

  constructor(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.cells = Array.from({ length: rows }, () => this.blankRow())
  }

  /** Applies a chunk of terminal output; sequences may span chunks. */
  write(data: Uint8Array | string) {
    const text =
      typeof data === 'string'
        ? data
        : this.decoder.decode(data, { stream: true })
    const input = this.pending + text
    this.pending = ''
    let index = 0
    while (index < input.length) {
      if (input[index] === '\x1b') {
        const end = this.escape(input, index)
        if (end === undefined) {
          this.pending = input.slice(index)
          return
        }
        index = end
        continue
      }
      const code = input.codePointAt(index) ?? 0
      // Code points above U+FFFF take two UTF-16 units.
      const units = code > 0xffff ? 2 : 1
      if (code === 0x0d) this.col = 0
      else if (code === 0x0a || code === 0x0b || code === 0x0c) this.lineFeed()
      else if (code === 0x08) this.col = Math.max(0, this.col - 1)
      else if (code === 0x09)
        this.col = Math.min(this.cols - 1, (this.col + 8) & ~7)
      else if (code >= 0x20 && code !== 0x7f)
        this.print(input.slice(index, index + units), code)
      index += units
    }
  }

  /** The text of every row, trailing blanks removed. */
  lines(): string[] {
    return this.cells.map((row) => row.join('').trimEnd())
  }

  /** Whether any single row currently shows `text`. */
  shows(text: string): boolean {
    return this.lines().some((line) => line.includes(text))
  }

  private blankRow() {
    return Array.from({ length: this.cols }, () => ' ')
  }

  private print(glyph: string, code: number) {
    // Combining marks and zero-width joiners join the previous cell.
    if (
      (code >= 0x0300 && code <= 0x036f) ||
      code === 0x200d ||
      (code >= 0xfe00 && code <= 0xfe0f)
    )
      return
    const width = isWide(code) ? 2 : 1
    if (this.col + width > this.cols) {
      this.col = 0
      this.lineFeed()
    }
    const row = this.cells[this.row] as string[]
    row[this.col] = glyph
    if (width === 2 && this.col + 1 < this.cols) row[this.col + 1] = ''
    this.col += width
  }

  private lineFeed() {
    if (this.row < this.rows - 1) {
      this.row++
      return
    }
    this.cells.shift()
    this.cells.push(this.blankRow())
  }

  private moveTo(row: number, col: number) {
    this.row = Math.min(this.rows - 1, Math.max(0, row))
    this.col = Math.min(this.cols - 1, Math.max(0, col))
  }

  /**
   * Consumes the escape sequence starting at `start` and returns the index
   * after it, or undefined when the input ends before the sequence does.
   */
  private escape(input: string, start: number): number | undefined {
    const kind = input[start + 1]
    if (kind === undefined) return undefined
    if (kind === '[') return this.csi(input, start + 2)
    // OSC, DCS, SOS, PM and APC strings end with BEL or ST (ESC \).
    if (
      kind === ']' ||
      kind === 'P' ||
      kind === 'X' ||
      kind === '^' ||
      kind === '_'
    ) {
      for (let index = start + 2; index < input.length; index++) {
        if (input[index] === '\x07') return index + 1
        if (input[index] === '\x1b') {
          if (index + 1 >= input.length) return undefined
          if (input[index + 1] === '\\') return index + 2
        }
      }
      return undefined
    }
    // Character set designations carry one more byte.
    if ('()*+-./#%'.includes(kind))
      return start + 2 < input.length ? start + 3 : undefined
    if (kind === '7') this.saved = { row: this.row, col: this.col }
    if (kind === '8') this.moveTo(this.saved.row, this.saved.col)
    if (kind === 'c') this.erase(0, 0, this.rows - 1, this.cols - 1)
    return start + 2
  }

  private csi(input: string, start: number): number | undefined {
    let index = start
    while (index < input.length) {
      const code = input.charCodeAt(index)
      if (code >= 0x40 && code <= 0x7e) break
      index++
    }
    if (index >= input.length) return undefined
    const body = input.slice(start, index)
    const final = input[index] as string
    // Private sequences (modes, queries) never move the cursor or draw.
    if (/^[<=>?]/.test(body)) return index + 1
    const params = body
      .replace(/[^0-9;:]/g, '')
      .split(';')
      .map((part) => Number.parseInt(part.split(':')[0] ?? '', 10))
    const arg = (at: number, fallback: number) => {
      const value = params[at]
      return value === undefined || Number.isNaN(value) || value === 0
        ? fallback
        : value
    }
    switch (final) {
      case 'H':
      case 'f':
        this.moveTo(arg(0, 1) - 1, arg(1, 1) - 1)
        break
      case 'A':
        this.moveTo(this.row - arg(0, 1), this.col)
        break
      case 'B':
      case 'e':
        this.moveTo(this.row + arg(0, 1), this.col)
        break
      case 'C':
      case 'a':
        this.moveTo(this.row, this.col + arg(0, 1))
        break
      case 'D':
        this.moveTo(this.row, this.col - arg(0, 1))
        break
      case 'E':
        this.moveTo(this.row + arg(0, 1), 0)
        break
      case 'F':
        this.moveTo(this.row - arg(0, 1), 0)
        break
      case 'G':
      case '`':
        this.moveTo(this.row, arg(0, 1) - 1)
        break
      case 'd':
        this.moveTo(arg(0, 1) - 1, this.col)
        break
      case 'J': {
        const mode = Number.isNaN(params[0]) ? 0 : params[0]
        if (mode === 0)
          this.erase(this.row, this.col, this.rows - 1, this.cols - 1)
        else if (mode === 1) this.erase(0, 0, this.row, this.col)
        else this.erase(0, 0, this.rows - 1, this.cols - 1)
        break
      }
      case 'K': {
        const mode = Number.isNaN(params[0]) ? 0 : params[0]
        if (mode === 0) this.erase(this.row, this.col, this.row, this.cols - 1)
        else if (mode === 1) this.erase(this.row, 0, this.row, this.col)
        else this.erase(this.row, 0, this.row, this.cols - 1)
        break
      }
      case 'X':
        this.erase(
          this.row,
          this.col,
          this.row,
          Math.min(this.cols - 1, this.col + arg(0, 1) - 1),
        )
        break
      case 's':
        this.saved = { row: this.row, col: this.col }
        break
      case 'u':
        this.moveTo(this.saved.row, this.saved.col)
        break
    }
    return index + 1
  }

  /** Blanks the cells from (fromRow, fromCol) through (toRow, toCol) in reading order. */
  private erase(
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number,
  ) {
    for (let row = fromRow; row <= toRow; row++) {
      const cells = this.cells[row] as string[]
      const first = row === fromRow ? fromCol : 0
      const last = row === toRow ? toCol : this.cols - 1
      for (let col = first; col <= last; col++) cells[col] = ' '
    }
  }
}

/** East Asian wide and emoji code points, which take two cells. */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}
