class FifoKeyCache {
  maxSize: number;
  currentIndex: number;
  cache: string[];

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.currentIndex = 0;
    this.cache = [];
  }

  exists(key: string): boolean {
    return this.cache.includes(key);
  }

  add(key: string): boolean {
    const isLastSlot = this.currentIndex === this.maxSize - 1;
    this.cache[this.currentIndex] = key;
    this.currentIndex = (this.currentIndex + 1) % this.maxSize;
    return isLastSlot;
  }

  debuger() {
    console.log(this.cache);
  }
}

export default FifoKeyCache;
