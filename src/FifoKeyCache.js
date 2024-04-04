class FifoKeyCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.currentIndex = 0;
    this.cache = [];
  }

  exists(key) {
    return this.cache.includes(key);
  }

  add(key) {
    const isLastSlot = this.currentIndex === this.maxSize - 1;
    this.cache[this.currentIndex] = key;
    this.currentIndex = (this.currentIndex + 1) % this.maxSize;
    return isLastSlot;
  }

  debuger() {
    console.log(this.cache);
  }
}

module.exports = FifoKeyCache;
