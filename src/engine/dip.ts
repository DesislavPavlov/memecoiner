/** A trough is only eligible AFTER an observed peak and qualifying decline. */
export class DipSetup {
    peak = 0;
    trough = 0;
    peakAt = 0;
    troughAt = 0;
    samples = 0;
    phase: "peak" | "dip" | "recovery" | "rejected" = "peak";
    constructor(readonly minDip: number, readonly maxDip: number) { }
    update(price: number, at: number): void {
        this.samples++;
        if (this.phase === "rejected")
            return;
        if (!this.peak || (this.phase === "peak" && price >= this.peak)) {
            this.peak = price;
            this.trough = price;
            this.peakAt = at;
            this.troughAt = at;
            return;
        }
        const decline = (1 - price / this.peak) * 100;
        if (decline > this.maxDip) {
            this.phase = "rejected";
            return;
        }
        if (this.phase === "peak" && decline >= this.minDip && at > this.peakAt) {
            this.phase = "dip";
            this.trough = price;
            this.troughAt = at;
        }
        else if (this.phase !== "peak") {
            if (price < this.trough) {
                this.trough = price;
                this.troughAt = at;
                this.phase = "dip";
            }
            else if (price > this.trough && at > this.troughAt)
                this.phase = "recovery";
        }
    }
    get dipPct(): number { return this.peak ? (1 - this.trough / this.peak) * 100 : 0; }
    recoveryPct(price: number): number { return this.trough ? (price / this.trough - 1) * 100 : 0; }
}
