import { describe, it, expect } from 'vitest'
import { encodeVectorFrame, fetchVectorsByIds, GET_BY_IDS_BATCH, GET_BY_IDS_CONCURRENCY } from './chunk-vectors'

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('encodeVectorFrame', () => {
  it('matches the golden frame container/test_app.py parses', () => {
    const frame = encodeVectorFrame([Float32Array.of(1, 2), [3, 4.5]], { texts: ['好'] })
    // header {"texts":["好"],"count":2,"dim":2} = 35 bytes -> 1 pad byte to offset 40
    expect(hex(frame)).toBe(
      '23000000' +
        Buffer.from('{"texts":["好"],"count":2,"dim":2}').toString('hex') +
        '00' +
        '0000803f' + '00000040' + '00004040' + '00009040'
    )
  })

  it('aligns the float block to 4 bytes for every header length', () => {
    for (let n = 0; n < 8; n++) {
      const frame = encodeVectorFrame([[n]], { pad: 'x'.repeat(n) })
      const headerLen = new DataView(frame.buffer).getUint32(0, true)
      const offset = frame.length - 4
      expect(offset % 4).toBe(0)
      expect(offset - 4 - headerLen).toBeLessThan(4)
      expect(new Float32Array(frame.buffer, offset, 1)[0]).toBe(n)
    }
  })

  it('rejects ragged rows and handles no rows', () => {
    expect(() => encodeVectorFrame([[1, 2], [3]])).toThrow(/dims/)
    const empty = encodeVectorFrame([])
    expect(JSON.parse(Buffer.from(empty.subarray(4, 4 + empty[0])).toString())).toEqual({ count: 0, dim: 0 })
  })
})

describe('fetchVectorsByIds', () => {
  it('reads in parallel batches of 20 within the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const batches: string[][] = []
    const index = {
      async getByIds(ids: string[], options?: { namespace?: string }) {
        expect(options).toEqual({ namespace: 'document' })
        batches.push(ids)
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        // id 7 has no vector; odd ids come back as number[] (both shapes occur).
        return ids.map((id) =>
          id === '7' ? null : { id, values: Number(id) % 2 ? [Number(id), 0] : Float32Array.of(Number(id), 0) }
        )
      },
    }
    const ids = Array.from({ length: 205 }, (_, i) => String(i))
    const out = await fetchVectorsByIds(index, ids)
    expect(batches).toHaveLength(11)
    expect(Math.max(...batches.map((b) => b.length))).toBe(GET_BY_IDS_BATCH)
    expect(peak).toBe(GET_BY_IDS_CONCURRENCY)
    expect(out.size).toBe(204)
    expect(out.has('7')).toBe(false)
    expect(out.get('9')).toEqual(Float32Array.of(9, 0))
    expect(out.get('204')).toBeInstanceOf(Float32Array)
  })

  it('makes no calls for no ids', async () => {
    const out = await fetchVectorsByIds({ getByIds: () => Promise.reject(new Error('called')) }, [])
    expect(out.size).toBe(0)
  })
})
