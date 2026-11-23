//! [INPUT]: Edge Read Aloud 握手时间、公用客户端标识
//! [OUTPUT]: Sec-MS-GEC v2 握手值
//! [POS]: Edge 协议的摘要计算，不涉及用户凭据
//! [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md

use std::num::Wrapping as W;

type Word = W<u32>;

// Edge 固定前缀对应的中间状态、消息调度和校验系数。
// 协议参考：https://github.com/rany2/edge-tts/blob/master/src/edge_tts/drm.py
const SHA_INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const PREFIX_STATE: [u32; 8] = [
    0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const PREFIX_ROUND_14: u32 = 0xc9dc06a7;
const PREFIX_SCHEDULE: [u32; 14] = [
    0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
    0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const SHA_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const CHECKSUM_PREFIX: [(u32, u32); 14] = [
    (0xe82e91b1, 0xb32700d0),
    (0x44de24c6, 0x88dff51d),
    (0x3beb65bc, 0x29514038),
    (0xc89c5933, 0xb328cbdf),
    (0x8d1ec211, 0xd405b4d5),
    (0x314ef5d5, 0x26e55f3c),
    (0xe92491b1, 0x607801c6),
    (0xf0a5b9d5, 0x82b2c1fb),
    (0x06064cf3, 0xfa51a3da),
    (0xda79fa60, 0x207cc464),
    (0xbed20560, 0x3c3c74f3),
    (0x89f9c9f8, 0xd2d14b61),
    (0x35fa38c6, 0xbb04a2c1),
    (0xcb49e3c6, 0xc5626167),
];

fn small0(w: Word) -> Word {
    let x = w.0;
    W(x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3))
}

fn small1(w: Word) -> Word {
    let x = w.0;
    W(x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10))
}

fn schedule(words: &[Word; 64], i: usize) -> Word {
    small1(words[i - 2]) + words[i - 7] + small0(words[i - 15]) + words[i - 16]
}

fn compress(mut state: [Word; 8], words: &[Word; 64], start: usize) -> [Word; 8] {
    for i in start..64 {
        let [a, b, c, d, e, f, g, h] = state;
        let k = if start == 14 && i == 14 {
            PREFIX_ROUND_14
        } else {
            SHA_K[i]
        };
        let x = a.0;
        let y = e.0;
        let a_sum = W(x.rotate_right(2) ^ x.rotate_right(13) ^ x.rotate_right(22));
        let e_sum = W(y.rotate_right(6) ^ y.rotate_right(11) ^ y.rotate_right(25));
        let choice = (e & f) ^ ((!e) & g);
        let majority = (a & b) ^ (a & c) ^ (b & c);
        let add = h + e_sum + choice + W(k) + words[i];
        state = [add + a_sum + majority, a, b, c, d + add, e, f, g];
    }
    state
}

fn digest(input: &[u8]) -> [u8; 32] {
    // 前 57 字节固定，第一块只需补入有效载荷的前 7 字节。
    let mut words = [W(0); 64];
    words[14] = W(u32::from_be_bytes([0, input[0], input[1], input[2]]));
    words[15] = W(u32::from_be_bytes(input[3..7].try_into().unwrap()));
    for (offset, &prefix) in PREFIX_SCHEDULE.iter().enumerate() {
        let i = offset + 16;
        words[i] = W(prefix) + schedule(&words, i);
        if i == 16 {
            let sigma = small1(words[14]);
            words[i] += (sigma ^ W(0x000b92c0)) - sigma;
        }
        if i == 29 {
            let sigma = small0(words[14]);
            words[i] += (sigma ^ W(0x059c0b80)) - sigma;
        }
    }
    words[30] = schedule(&words, 30) + W(PREFIX_ROUND_14) - W(SHA_K[14]);
    for i in 31..64 {
        words[i] = schedule(&words, i);
    }
    let partial = compress(PREFIX_STATE.map(W), &words, 14);
    let mut hash = std::array::from_fn(|i| W(SHA_INITIAL[i]) + partial[i]);

    let len = (57 + input.len()) as u64;
    let mut remaining = input[7..].to_vec();
    remaining.push(0x80);
    remaining.resize((remaining.len() + 8).div_ceil(64) * 64 - 8, 0);
    remaining.extend_from_slice(&(len * 8).to_be_bytes());
    for block in remaining.chunks_exact(64) {
        for (i, word) in block.chunks_exact(4).enumerate() {
            words[i] = W(u32::from_be_bytes(word.try_into().unwrap()));
        }
        for i in 16..64 {
            words[i] = schedule(&words, i);
        }
        let partial = compress(hash, &words, 0);
        for i in 0..8 {
            hash[i] += partial[i];
        }
    }
    let mut bytes = [0; 32];
    for (word, output) in hash.iter().zip(bytes.chunks_exact_mut(4)) {
        output.copy_from_slice(&word.0.to_be_bytes());
    }
    bytes
}

fn rot(x: Word) -> Word {
    W(x.0.rotate_left(16))
}

fn checksum(input: &[u8], digest: &[u8; 32]) -> [u8; 8] {
    let keys = [
        W(u32::from_le_bytes(digest[..4].try_into().unwrap()) | 1),
        W(u32::from_le_bytes(digest[4..8].try_into().unwrap()) | 1),
    ];
    let factors = keys.map(|key| key * W(0x82893933));
    let prefix = CHECKSUM_PREFIX
        .iter()
        .enumerate()
        .map(|(i, &(a, b))| (W(a) * factors[i % 2], W(b)));
    let mut padded = vec![0];
    padded.extend_from_slice(input);
    padded.resize(padded.len().next_multiple_of(8), 0);
    let mut terms = prefix.chain(padded.chunks_exact(4).enumerate().map(|(i, bytes)| {
        let word = W(u32::from_le_bytes(bytes.try_into().unwrap()));
        let index = i % 2;
        let mut term = word * keys[index];
        let mut offset = rot(word) * W([0xef0569fb, 0xc31713db][index]);
        if i == 0 {
            term += W(0xf2f90b1a) * factors[0];
            offset += W(0x0b1a0000);
        }
        (term, offset)
    }));
    let (mut swapped_sum, mut swapped_tail, mut state, mut state_sum) = (W(0), W(0), W(0), W(0));
    while let (Some((a, left)), Some((b, right))) = (terms.next(), terms.next()) {
        let x = rot(left + a) * W(0x76f50f34);
        let y = rot(right + b) * W(0x1881ce3c);
        swapped_tail = y + rot(y) * W(0x35bd1ec9);
        swapped_sum += x + rot(x) * W(0xc3efea97) + swapped_tail;

        state = state * keys[0] + a;
        for factor in [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83] {
            state = rot(state) * W(factor);
        }
        state_sum += state;
        let x = state * keys[1] + b;
        let y = rot(x) * W(0xa27416f5);
        let z = rot(y) * W(0xd38396ff);
        state = rot(rot(z) * W(0x7c932b89)) * W(0xbfa49f69);
        state_sum += state;
    }
    let mut result = [0; 8];
    result[..4].copy_from_slice(&(swapped_tail ^ state).0.to_le_bytes());
    result[4..].copy_from_slice(&(swapped_sum ^ state_sum).0.to_le_bytes());
    result
}

pub fn token(unix_seconds: u64, client: &str) -> String {
    let ticks = (unix_seconds + 11_644_473_600) / 300 * 3_000_000_000;
    let input = format!("{ticks}{client}");
    let hash = digest(input.as_bytes());
    format!(
        "{}-{}",
        hex::encode_upper(checksum(input.as_bytes(), &hash)),
        hex::encode_upper(hash)
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_protocol_vector() {
        let actual = super::token(1_700_000_000, "6A5AA1D4EAFF4E9FB37E23D68491D6F4");
        assert_eq!(
            actual,
            "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"
        );
    }
}
