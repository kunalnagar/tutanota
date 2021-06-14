/**
 * lz4 compression/decompression routines adopted from the node-lz4 library
 * https://github.com/pierrec/node-lz4
 * (which is a port of the original LZ4 library http://www.lz4.org).
 *
 * node-lz4 does a lot of things we don't need and drags Node Buffer and
 * whatnot with it and subsequently weights 103KB.
 *
 * Modified to include auto-resizing of the buffer and slicing of the data.
 */

/*
Copyright (c) 2012 Pierre Curto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 */

// @flow

if (!Math.imul) {
	Math.imul = function imul(a, b) {
		const ah = a >>> 16
		const al = a & 0xffff
		const bh = b >>> 16
		const bl = b & 0xffff
		return (al * bl + ((ah * bl + al * bh) << 16)) | 0;
	};
}

/**
 * Decode a block. Assumptions: input contains all sequences of a
 * chunk.
 * @param input {Buffer} input data
 * @throws on invalid offset
 * @return {Uint8Array} decoded data
 */
export function uncompress(input: Uint8Array): Uint8Array {
	const endIndex = input.length
	let output = new Uint8Array(input.length * 6)
	let j = 0
	// Process each sequence in the incoming data
	for (let i = 0, n = endIndex; i < n;) {
		let token = input[i++]

		// Literals
		let literals_length = (token >> 4)
		if (literals_length > 0) {
			// length of literals
			let l = literals_length + 240
			while (l === 255) {
				l = input[i++]
				literals_length += l
			}

			// Copy the literals
			let end = i + literals_length
			const sizeNeeded = j + (end - i)
			if (output.length < sizeNeeded) {
				const newSize = Math.max(output.length * 2, sizeNeeded)
				const newOutput = new Uint8Array(newSize)
				newOutput.set(output)
				output = newOutput
			}
			while (i < end) output[j++] = input[i++]

			// End of buffer?
			if (i === n) break // return j
		}

		// Match copy
		// 2 bytes offset (little endian)
		let offset = input[i++] | (input[i++] << 8)

		// 0 is an invalid offset value
		if (offset === 0 || offset > j) {
			// was:
			// return -(i - 2)
			throw new Error(`Invalid offset value. i: ${i}, -(i-2): ${-(i - 2)}`)
		}

		// length of match copy
		let match_length = (token & 0xf)
		let l = match_length + 240
		while (l === 255) {
			l = input[i++]
			match_length += l
		}

		// Copy the match
		let pos = j - offset // position of the match copy in the current output
		let end = j + match_length + 4 // minmatch = 4
		const sizeNeeded = end
		if (output.length < sizeNeeded) {
			const newSize = Math.max(output.length * 2, sizeNeeded)
			const newOutput = new Uint8Array(newSize)
			newOutput.set(output)
			output = newOutput
		}
		while (j < end) output[j++] = output[pos++]
	}
	return output.slice(0, j)
}

const maxInputSize = 0x7E000000
const minMatch = 4
const hashLog = 16
const hashShift = (minMatch * 8) - hashLog
const hashSize = (1 << hashLog)
const copyLength = 8
const minInputSize = copyLength + minMatch
const skipStrength = 6
const mlBits = 4
const mlMask = (1 << mlBits) - 1
const runBits = 8 - mlBits
const runMask = (1 << runBits) - 1
const hasher = 2654435761


export function compress(source: Uint8Array): Uint8Array {
	const dest = new Uint8Array(compressBound(source.length))
	const idk = _compress(source, dest, 0, dest.length)

	return dest
}

// CompressBound returns the maximum length of a lz4 block, given it's uncompressed length
function compressBound(isize) {
	return isize > maxInputSize
		? 0
		: (isize + (isize / 255) + 16) | 0
}


// TODO cut out the middle man, don't take dst as an input param
function _compress(src, dst, sIdx, eIdx) {

	if (src.length >= maxInputSize) throw new Error("input too large")
	if (src.length <= minInputSize) throw new Error("input too small")


	// Minimum of input bytes for compression (LZ4 specs)
	const maxCompressedSize = compressBound(src.length)
	if (dst.length < maxCompressedSize) throw Error("output too small: " + dst.length + " < " + maxCompressedSize)

	// V8 optimization: non sparse array with integers
	const hashTable = new Array(hashSize).fill(0)
	return compressBlock(src, dst, 0, hashTable, sIdx || 0, eIdx || dst.length)
}

function compressBlock(src, dst, pos, hashTable, startIndex, endIndex) {
	let destPos = startIndex
	let anchor = 0
	let step = 1
	let findMatchAttempts = (1 << skipStrength) + 3
	const srcLength = src.length - minInputSize

	while (pos + minMatch < srcLength) {
		// Find a match
		// min match of 4 bytes aka sequence
		const sequenceLowBits = src[pos + 1] << 8 | src[pos]
		const sequenceHighBits = src[pos + 3] << 8 | src[pos + 2]
		// compute hash for the current sequence
		const hash = Math.imul(sequenceLowBits | (sequenceHighBits << 16), hasher) >>> hashShift
		// get the position of the sequence matching the hash
		// NB. since 2 different sequences may have the same hash
		// it is double-checked below
		// do -1 to distinguish between initialized and uninitialized values
		let ref = hashTable[hash] - 1
		// save position of current sequence in hash table
		hashTable[hash] = pos + 1

		// first reference or within 64k limit or current sequence !== hashed one: no match
		if (ref < 0 ||
			((pos - ref) >>> 16) > 0 ||
			(
				((src[ref + 3] << 8 | src[ref + 2]) != sequenceHighBits) ||
				((src[ref + 1] << 8 | src[ref]) != sequenceLowBits)
			)
		) {
			// increase step if nothing found within limit
			step = findMatchAttempts++ >> skipStrength
			pos += step
			continue
		}

		findMatchAttempts = (1 << skipStrength) + 3

		// got a match
		const literals_length = pos - anchor
		const offset = pos - ref

		// minMatch already verified
		pos += minMatch
		ref += minMatch

		// move to the end of the match (>=minMatch)
		let match_length = pos
		while (pos < srcLength && src[pos] == src[ref]) {
			pos++
			ref++
		}

		// match length
		match_length = pos - match_length

		// token
		const token = match_length < mlMask ? match_length : mlMask

		// encode literals length
		if (literals_length >= runMask) {
			let len
// add match length to the token
			dst[destPos++] = (runMask << mlBits) + token
			for (len = literals_length - runMask; len > 254; len -= 255) {
				dst[destPos++] = 255
			}
			dst[destPos++] = len
		} else {
			// add match length to the token
			dst[destPos++] = (literals_length << mlBits) + token
		}

		// write literals
		for (let i = 0; i < literals_length; i++) {
			dst[destPos++] = src[anchor + i]
		}

		// encode offset
		dst[destPos++] = offset
		dst[destPos++] = (offset >> 8)

		// encode match length
		if (match_length >= mlMask) {
			match_length -= mlMask
			while (match_length >= 255) {
				match_length -= 255
				dst[destPos++] = 255
			}

			dst[destPos++] = match_length
		}

		anchor = pos
	}

	// cannot compress input
	if (anchor === 0) return 0

	// Write last literals
	// encode literals length
	const literals_length = src.length - anchor
	if (literals_length >= runMask) {
		let ln = literals_length - runMask
		// add match length to the token
		dst[destPos++] = (runMask << mlBits)
		while (ln > 254) {
			dst[destPos++] = 255
			ln -= 255
		}
		dst[destPos++] = ln
	} else {
		// add match length to the token
		dst[destPos++] = (literals_length << mlBits)
	}

	// write literals
	pos = anchor
	while (pos < src.length) {
		dst[destPos++] = src[pos++]
	}

	return destPos
}
