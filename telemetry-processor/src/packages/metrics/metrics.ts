export class Metrics {
  constructor() { this.values = new Map(); }
  inc(name, labels = {}, value = 1) { const key = `${name}|${JSON.stringify(labels)}`; const current = this.values.get(key) ?? { name, labels, value: 0, type: 'counter' }; current.value += value; this.values.set(key, current); }
  set(name, value, labels = {}) { this.values.set(`${name}|${JSON.stringify(labels)}`, { name, labels, value, type: 'gauge' }); }
  render() {
    return [...this.values.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(({ name, labels, value }) => {
      const suffix = Object.keys(labels).length ? `{${Object.entries(labels).map(([k,v]) => `${k}=${JSON.stringify(String(v))}`).join(',')}}` : '';
      return `${name}${suffix} ${Number(value)}`;
    }).join('\n') + '\n';
  }
}
