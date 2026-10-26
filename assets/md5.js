/* md5.js —— 流式 MD5（支持大文件分块计算，纯 JS，无依赖）
 *
 * 浏览器 WebCrypto 不提供 MD5（不安全哈希被刻意移除），
 * 而「选压缩包 → 算 MD5 → 查密码」是核心场景，所以这里自带一份实现。
 *
 * 用法：
 *   const h = new Md5();
 *   h.update(uint8array);
 *   h.hex();              // 32 位小写十六进制
 *   await Md5.hashFile(file, onProgress);   // 流式读取文件，带进度回调
 */
(function (global) {
  'use strict';

  // 每轮的循环左移位数
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  // K[i] = floor(abs(sin(i + 1)) * 2^32)
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }

  class Md5 {
    constructor() {
      this._h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
      this._buf = new Uint8Array(64);
      this._bufLen = 0;
      this._bytes = 0;
      this._w = new Uint32Array(16);
      this._finished = false;
    }

    /** 追加数据；data 为 Uint8Array（也接受 ArrayBuffer） */
    update(data) {
      if (this._finished) throw new Error('Md5: 已 finalize，不能继续 update');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      this._bytes += bytes.length;

      let offset = 0;
      if (this._bufLen > 0) {
        const take = Math.min(64 - this._bufLen, bytes.length);
        this._buf.set(bytes.subarray(0, take), this._bufLen);
        this._bufLen += take;
        offset = take;
        if (this._bufLen === 64) {
          this._block(this._buf, 0);
          this._bufLen = 0;
        }
      }
      while (offset + 64 <= bytes.length) {
        this._block(bytes, offset);
        offset += 64;
      }
      if (offset < bytes.length) {
        this._buf.set(bytes.subarray(offset), 0);
        this._bufLen = bytes.length - offset;
      }
      return this;
    }

    _block(buf, pos) {
      const w = this._w;
      for (let i = 0; i < 16; i++) {
        const j = pos + i * 4;
        w[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
      }
      let a = this._h[0];
      let b = this._h[1];
      let c = this._h[2];
      let d = this._h[3];

      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) & 15;
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) & 15;
        }
        const sum = (a + f + K[i] + w[g]) | 0;
        const rot = (sum << S[i]) | (sum >>> (32 - S[i]));
        const next = (b + rot) | 0;
        a = d;
        d = c;
        c = b;
        b = next;
      }

      this._h[0] = (this._h[0] + a) >>> 0;
      this._h[1] = (this._h[1] + b) >>> 0;
      this._h[2] = (this._h[2] + c) >>> 0;
      this._h[3] = (this._h[3] + d) >>> 0;
    }

    /** 收尾并输出十六进制摘要（调用后实例不可再用） */
    hex() {
      if (!this._finished) {
        const bitsLo = (this._bytes * 8) >>> 0;
        const bitsHi = Math.floor(this._bytes / 536870912) >>> 0; // bytes*8 / 2^32
        const padLen = this._bufLen < 56 ? 56 - this._bufLen : 120 - this._bufLen;
        const pad = new Uint8Array(padLen + 8);
        pad[0] = 0x80;
        const end = pad.length;
        pad[end - 8] = bitsLo & 0xff;
        pad[end - 7] = (bitsLo >>> 8) & 0xff;
        pad[end - 6] = (bitsLo >>> 16) & 0xff;
        pad[end - 5] = (bitsLo >>> 24) & 0xff;
        pad[end - 4] = bitsHi & 0xff;
        pad[end - 3] = (bitsHi >>> 8) & 0xff;
        pad[end - 2] = (bitsHi >>> 16) & 0xff;
        pad[end - 1] = (bitsHi >>> 24) & 0xff;
        this.update(pad);
        this._finished = true;
      }
      let out = '';
      for (let i = 0; i < 4; i++) {
        const v = this._h[i];
        for (let j = 0; j < 4; j++) {
          out += ((v >>> (j * 8)) & 0xff).toString(16).padStart(2, '0');
        }
      }
      return out;
    }

    /** 便捷方法：一次性算字符串或字节的 MD5 */
    static hash(data) {
      return new Md5().update(typeof data === 'string' ? new TextEncoder().encode(data) : data).hex();
    }

    /**
     * 流式计算文件 MD5。
     * @param {File|Blob} file
     * @param {(loaded:number, total:number)=>void} [onProgress]
     * @returns {Promise<string>}
     */
    static async hashFile(file, onProgress) {
      const hasher = new Md5();
      const total = file.size;

      // 现代浏览器都支持 Blob.stream()
      if (typeof file.stream === 'function') {
        const reader = file.stream().getReader();
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hasher.update(value);
          loaded += value.length;
          if (onProgress) onProgress(loaded, total);
        }
        return hasher.hex();
      }

      // 兜底：分片 FileReader
      const CHUNK = 8 * 1024 * 1024;
      let offset = 0;
      while (offset < total) {
        const slice = file.slice(offset, Math.min(offset + CHUNK, total));
        const buf = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(new Uint8Array(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsArrayBuffer(slice);
        });
        hasher.update(buf);
        offset += buf.length;
        if (onProgress) onProgress(offset, total);
      }
      return hasher.hex();
    }
  }

  global.Md5 = Md5;
})(typeof window !== 'undefined' ? window : globalThis);
