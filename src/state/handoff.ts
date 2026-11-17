// Small hand-offs between the top bar / guide and a page that opens next: a search typed in the top bar
// (kept out of the URL, since it may hold a person's name) and text to put in the assistant's box.
let pendingSearch = '';
export const setPendingSearch = (q: string) => { pendingSearch = q; };
export const peekSearch = () => pendingSearch;
export const clearSearch = () => { pendingSearch = ''; };
