import { Graph } from '../models/Graph.js';
import { Vertex } from '../models/Vertex.js';
import { VertexType } from '../models/VertexType.js';
import { Edge } from '../models/Edge.js';

/**
 * Matrix-based Modified Contraction Algorithm (m-MCA)
 *
 * Implements Algorithm 3 (Phase 1: Contraction Path Generation) and
 * Algorithm 4 (Phase 2: Contraction Path Minimisation) from:
 *   Amancio, "Matrix-based MCA for RDLT Separation" (CMSC 199.1)
 *
 * Which formalises the graph-based MCA from:
 *   Malinao & Juayong (2024) "MinCS and MAS in RDLTs", SciEnggJ Vol.17 No.01.
 *
 * ─── Public API ────────────────────────────────────────────────────────────
 *   MCAAlgorithm.getAllMinCS(Ri, sourceId, sinkId)
 *     → Array<{ vertices: Vertex[], edges: Edge[] }>   (all distinct MinCS)
 *
 * MAS generation (adding looping arcs, fixing L-values) is handled by the
 * MASExtractor after calling getAllMinCS().
 */
export class MCAAlgorithm {

    // ══════════════════════════════════════════════════════════════════════
    //  Public entry-point
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Extract ALL Minimal Contraction Structures (MinCS) from an expanded
     * vertex-simplified RDLT Ri.
     *
     * @param {Graph}  Ri       – level-i vertex-simplified RDLT
     * @param {string} sourceId – id of the source vertex
     * @param {string} sinkId   – id of the sink vertex
     * @returns {Array<{vertices:Vertex[], edges:Edge[]}>}
     */
    static getAllMinCS(Ri, sourceId, sinkId) {
        console.log(`[MCA] getAllMinCS  source=${sourceId}  sink=${sinkId}`);
        console.log(`[MCA] V=[${Ri.vertices.map(v => v.id)}]`);
        console.log(`[MCA] E=[${Ri.edges.map(e => `${e.from.id}→${e.to.id}(${this._nc(e.constraint)})`)}]`);

        // Phase 1 ─ enumerate ALL distinct contraction paths
        const allPaths = this._phase1(Ri, sourceId, sinkId);
        console.log(`[MCA] Phase 1 → ${allPaths.length} contraction path(s): ${allPaths.map(p => '[' + [...p].join(',') + ']')}`);

        // Phase 2 ─ minimise each path; deduplicate
        let result  = [];
        const seenKey = new Set();

        for (const P of allPaths) {
            const minCS = this._phase2(Ri, P, sourceId, sinkId);
            if (!minCS) continue;
            const key = this._minCSKey(minCS);
            if (!seenKey.has(key)) {
                seenKey.add(key);
                result.push(minCS);
                console.log(`[MCA] MinCS #${result.length}  V=[${minCS.vertices.map(v => v.id)}]  E=[${minCS.edges.map(e => `${e.from.id}→${e.to.id}(${this._nc(e.constraint)})`)}]`);
            }
        }

        console.log(`[MCA] Phase 2 complete: ${result.length} MinCS before join merging`);

        // Phase 3 ─ merge based on join semantics (AND/MIX/OR)
        result = this._mergeByJoinType(Ri, result);

        console.log(`[MCA] Total distinct MinCS: ${result.length}`);
        return result;
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Phase 1 – Contraction Path Generation (Algorithm 3)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Enumerate every distinct contraction path P from sourceId to sinkId.
     *
     * A contraction path is a set of original vertex IDs that get absorbed
     * into the dummy merged node x as the algorithm contracts edges toward
     * the sink.  Different valid choices of y (the next vertex to absorb)
     * lead to different contraction paths, so we backtrack over all of them.
     *
     * @returns {Array<Set<string>>}
     */
    static _phase1(Ri, sourceId, sinkId) {
        // Build an arc-map that represents C-attributes of forward arcs only
        const initMap = this._buildArcMap(Ri, /* excludeLooping */ true);

        const paths   = [];
        const seenP   = new Set();
        const LIMIT   = 500; // safety cap on total paths

        /**
         * Recursive backtracking over all valid contraction choices.
         * Implements Algorithm 1 steps 8-14 with backtracking.
         */
        const backtrack = (arcMap, mergedId, absorbed) => {
            if (paths.length >= LIMIT) return;

            // Termination: sink has been absorbed
            if (absorbed.has(sinkId)) {
                const key = [...absorbed].sort().join(',');
                if (!seenP.has(key)) {
                    seenP.add(key);
                    paths.push(new Set(absorbed));
                }
                return;
            }

            // Y = vertices directly reachable from the merged dummy node x
            const Y = this._outNeighbors(arcMap, mergedId);
            if (Y.length === 0) return; // dead end

            for (const y of Y) {
                // ── LHS = C(x,y) ∪ {ε}  (Algorithm 1, step 11) ──────────
                const LHS = new Set([...this._getCAttrs(arcMap, mergedId, y), '']);

                // ── U = all u ≠ x with arc to y ───────────────────────────
                const U = this._inNeighbors(arcMap, y).filter(u => u !== mergedId);

                // ── RHS = ∪{C(u,y) : u ∈ U} ───────────────────────────────
                const RHS = new Set(U.flatMap(u => [...this._getCAttrs(arcMap, u, y)]));

                // ── Contraction condition: LHS ⊇ RHS  (step 11) ───────────
                if (!this._isSuperset(LHS, RHS)) continue;

                // Valid choice – clone state before mutating (backtracking)
                const newMap = this._cloneArcMap(arcMap);

                // Update C(u,y) = ε for all u ∈ U  (step 12)
                for (const u of U) {
                    if (newMap.get(u)?.has(y)) newMap.get(u).set(y, new Set(['']));
                }

                // Merge x and y into z  (step 13)
                const z = `${mergedId}\u2295${y}`;
                this._mergeVertices(newMap, mergedId, y, z);

                // Update P = P ∪ {y}  (step 14)
                backtrack(newMap, z, new Set([...absorbed, y]));
            }
        };

        backtrack(initMap, sourceId, new Set([sourceId]));

        return paths;
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Phase 2 – Contraction Path Minimisation (Algorithm 4)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Given contraction path P (set of original vertex IDs), induce Rmin
     * from Ri and apply weight-based pruning to produce the MinCS.
     *
     * Key insight: arcs with duplicate C-values to the same JOIN vertex
     * end up with W = 0 and are removed, leaving only the essential paths.
     * Looping arcs also end up with W = 0 (they never appear on any simple
     * forward path from source to a merge-point) and are pruned – they are
     * added back later when generating the full MAS.
     *
     * @param {Graph}       Ri
     * @param {Set<string>} P        – vertex IDs in the contraction path
     * @param {string}      sourceId
     * @param {string}      sinkId
     * @returns {{ vertices: Vertex[], edges: Edge[] } | null}
     */
    static _phase2(Ri, P, sourceId, sinkId) {
        // ── Step 1: Induce Rmin ───────────────────────────────────────────
        const rminV = Ri.vertices.filter(v => P.has(v.id));
        const rminE = Ri.edges.filter(e => P.has(e.from.id) && P.has(e.to.id));

        if (rminV.length === 0) return null;
        if (rminE.length === 0) return { vertices: rminV, edges: [] };

        // ── Step 4: Initialise weight W(a,b) = 0 for every arc ───────────
        // Key format: "fromId→toId"
        const W = new Map();
        for (const e of rminE) {
            const k = `${e.from.id}→${e.to.id}`;
            if (!W.has(k)) W.set(k, 0);
        }

        // ── Step 5: MP = vertices in Rmin with ≥1 incoming arc ───────────
        const hasIncoming = new Set(rminE.map(e => e.to.id));
        const MPverts = rminV.filter(v => hasIncoming.has(v.id));

        // Identify looping arcs within Rmin (needed to build forward-only graph)
        const isLooping = (e) => this._isLoopingArc(Ri.edges, e.from.id, e.to.id);
        const fwdEdges  = rminE.filter(e => !isLooping(e));

        // Topological order of MP so we process vertices source → sink
        const allIds  = rminV.map(v => v.id);
        const topoIds = this._topoSort(allIds, fwdEdges);
        const orderedMP = topoIds.filter(id => hasIncoming.has(id));

        // ── Step 6: visitedMP ← {} ───────────────────────────────────────
        const visitedMP = new Set();

        // ── Steps 7-24: for each merge point y ───────────────────────────
        for (const yId of orderedMP) {
            // Step 8: elementary path Q from source to y (DFS on forward arcs)
            const Q = this._findPath(fwdEdges, sourceId, yId);
            if (!Q || Q.length < 2) {
                visitedMP.add(yId);
                continue;
            }

            const n = Q.length; // Q[0]=source, Q[n-1]=y

            // Steps 9-23: walk path backwards from y toward source
            for (let j = n - 1; j >= 1; j--) {
                const vj  = Q[j];      // current vertex (y when j = n-1)
                const vj1 = Q[j - 1];  // predecessor on path

                // ── Steps 10-12 ──────────────────────────────────────────
                // distinctCValue ← {}
                // distinctCValue ← distinctCValue ∪ { C(vj-1, vj) }
                // W(vj-1, vj) ← W(vj-1, vj) + 1
                const distinctC = new Set();
                const cMain = this._getEdgeConstraint(rminE, vj1, vj);
                distinctC.add(cMain);
                const keyMain = `${vj1}→${vj}`;
                W.set(keyMain, (W.get(keyMain) ?? 0) + 1);

                // ── Steps 13-18: check every other incoming arc to vj ─────
                // for each u where (u,vj) ∈ E, u ≠ vj-1:
                //   if C(u,vj) ∉ distinctC:
                //     distinctC ← distinctC ∪ {C(u,vj)}
                //     W(u,vj) ← W(u,vj) + 1
                for (const e of rminE) {
                    if (e.to.id !== vj || e.from.id === vj1) continue;
                    const c = this._nc(e.constraint);
                    if (!distinctC.has(c)) {
                        distinctC.add(c);
                        const k = `${e.from.id}→${vj}`;
                        W.set(k, (W.get(k) ?? 0) + 1);
                    }
                    // arcs with duplicate C stay at weight 0 → pruned later
                }

                // ── Step 19: visitedMP ← visitedMP ∪ {vj} ────────────────
                visitedMP.add(vj);

                // ── Step 20-22: break condition ──────────────────────────
                if (visitedMP.has(vj1) || vj1 === sourceId) break;
            }
        }

        // ── Step 25: keep arcs with W(a,b) > 0 ───────────────────────────
        const keptEdges = rminE.filter(e => (W.get(`${e.from.id}→${e.to.id}`) ?? 0) > 0);

        // Vertices used by kept edges (always include source; try to include sink)
        const keptVIds = new Set([sourceId]);
        for (const e of keptEdges) {
            keptVIds.add(e.from.id);
            keptVIds.add(e.to.id);
        }
        // Always keep the sink vertex if it was in P
        if (P.has(sinkId)) keptVIds.add(sinkId);

        return {
            vertices: rminV.filter(v => keptVIds.has(v.id)),
            edges: keptEdges
        };
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Arc-map helpers (used by Phase 1)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Build Map<fromId, Map<toId, Set<normalisedC>>> from Graph.
     * If excludeLooping=true, looping arcs are omitted.
     */
    static _buildArcMap(Ri, excludeLooping = true) {
        const map = new Map();
        for (const v of Ri.vertices) map.set(v.id, new Map());

        for (const e of Ri.edges) {
            if (excludeLooping && this._isLoopingArc(Ri.edges, e.from.id, e.to.id)) continue;
            const src = e.from.id, tgt = e.to.id;
            if (!map.has(src)) map.set(src, new Map());
            if (!map.get(src).has(tgt)) map.get(src).set(tgt, new Set());
            map.get(src).get(tgt).add(this._nc(e.constraint));
        }
        return map;
    }

    static _cloneArcMap(map) {
        const clone = new Map();
        for (const [from, toMap] of map) {
            const m2 = new Map();
            for (const [to, cs] of toMap) m2.set(to, new Set(cs));
            clone.set(from, m2);
        }
        return clone;
    }

    /** Outgoing neighbours of v (targets with non-empty C-set). */
    static _outNeighbors(arcMap, v) {
        const m = arcMap.get(v);
        if (!m) return [];
        return [...m.entries()].filter(([, cs]) => cs.size > 0).map(([id]) => id);
    }

    /** All vertices u that have at least one arc to target v. */
    static _inNeighbors(arcMap, v) {
        const res = [];
        for (const [from, toMap] of arcMap) {
            if (toMap.has(v) && toMap.get(v).size > 0) res.push(from);
        }
        return res;
    }

    /** C-attribute set for the arc from→to (empty set if none). */
    static _getCAttrs(arcMap, from, to) {
        return arcMap.get(from)?.get(to) ?? new Set();
    }

    /** True iff every element of B is in A. */
    static _isSuperset(A, B) {
        for (const item of B) if (!A.has(item)) return false;
        return true;
    }

    /**
     * Merge vertices x and y into z (Algorithm 3, lines 21-45).
     *
     *  RowMerge adj: row(z) = row(x) + row(y)   (set-union of C-attrs)
     *  ColMerge adj: col(z) = col(x) + col(y)
     *  adj(z,z)     = 0   (no self-loop)
     */
    static _mergeVertices(arcMap, x, y, z) {
        const outX = arcMap.get(x) ?? new Map();
        const outY = arcMap.get(y) ?? new Map();

        // Merged outgoing row for z
        const outZ = new Map();
        const targets = new Set([...outX.keys(), ...outY.keys()]);
        for (const t of targets) {
            if (t === x || t === y) continue; // skip self-loops
            const merged = new Set([...(outX.get(t) ?? new Set()), ...(outY.get(t) ?? new Set())]);
            if (merged.size > 0) outZ.set(t, merged);
        }

        arcMap.delete(x);
        arcMap.delete(y);
        arcMap.set(z, outZ);

        // Update column: replace arcs to x or y with arcs to z
        for (const [from, toMap] of arcMap) {
            if (from === z) continue;
            const cToX = toMap.get(x) ?? new Set();
            const cToY = toMap.get(y) ?? new Set();
            toMap.delete(x);
            toMap.delete(y);
            const merged = new Set([...cToX, ...cToY]);
            if (merged.size > 0) toMap.set(z, merged);
        }
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Graph traversal helpers (used by Phase 2)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Kahn's-algorithm topological sort.
     * @param {string[]} vertexIds
     * @param {Edge[]}   fwdEdges – forward (non-looping) edges of the graph
     * @returns {string[]} vertex IDs in topological order
     */
    static _topoSort(vertexIds, fwdEdges) {
        const inDeg = new Map(vertexIds.map(id => [id, 0]));
        const adj   = new Map(vertexIds.map(id => [id, []]));

        for (const e of fwdEdges) {
            if (!inDeg.has(e.from.id) || !inDeg.has(e.to.id)) continue;
            adj.get(e.from.id).push(e.to.id);
            inDeg.set(e.to.id, inDeg.get(e.to.id) + 1);
        }

        const queue = vertexIds.filter(id => inDeg.get(id) === 0);
        const order = [];

        while (queue.length > 0) {
            const u = queue.shift();
            order.push(u);
            for (const v of (adj.get(u) ?? [])) {
                const d = inDeg.get(v) - 1;
                inDeg.set(v, d);
                if (d === 0) queue.push(v);
            }
        }

        // Append unreached vertices (shouldn't happen in a valid RDLT DAG)
        for (const id of vertexIds) if (!order.includes(id)) order.push(id);
        return order;
    }

    /**
     * Find ONE elementary path from sourceId to targetId via DFS.
     * Uses only the forward (non-looping) edges supplied.
     * Returns array of vertex IDs [source, ..., target] or null.
     */
    static _findPath(fwdEdges, sourceId, targetId) {
        const adj = new Map();
        for (const e of fwdEdges) {
            if (!adj.has(e.from.id)) adj.set(e.from.id, []);
            adj.get(e.from.id).push(e.to.id);
        }

        const path    = [];
        const visited = new Set();

        const dfs = (cur) => {
            if (cur === targetId) { path.push(cur); return true; }
            if (visited.has(cur)) return false;
            visited.add(cur);
            path.push(cur);
            for (const nxt of (adj.get(cur) ?? [])) {
                if (dfs(nxt)) return true;
            }
            path.pop();
            return false;
        };

        return dfs(sourceId) ? path : null;
    }

    /**
     * Return the normalised C-attribute of (one instance of) edge from→to.
     */
    static _getEdgeConstraint(edges, fromId, toId) {
        const e = edges.find(e => e.from.id === fromId && e.to.id === toId);
        return e ? this._nc(e.constraint) : '';
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Join Classification and Merging (Phase 3)
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Classify JOIN vertices by type, considering only non-looping incoming arcs.
     * 
     * - AND-join: All non-looping incoming arcs have DISTINCT non-epsilon C-attributes
     * - MIX-join: Mix of epsilon and non-epsilon C-attributes  
     * - OR-join: All same C-attribute (or all epsilon)
     *
     * @param {Graph} rdlt - The RDLT graph
     * @returns {{ andJoins: Vertex[], mixJoins: Vertex[] }}
     */
    static _classifyJoinVertices(rdlt) {
        const andJoins = [];
        const mixJoins = [];

        for (const vertex of rdlt.vertices) {
            // Get all incoming arcs
            const allIncoming = rdlt.edges.filter(e => e.to.id === vertex.id);
            
            // Filter to non-looping arcs only (looping arcs don't affect join type)
            const incomingEdges = allIncoming.filter(e => 
                !this._isLoopingArc(rdlt.edges, e.from.id, e.to.id)
            );
            
            if (incomingEdges.length < 2) continue; // Not a join

            // Collect C-attributes
            const constraints = incomingEdges.map(e => this._nc(e.constraint));
            const hasEpsilon = constraints.some(c => c === '');
            const nonEpsilonConstraints = new Set(constraints.filter(c => c !== ''));

            if (!hasEpsilon && nonEpsilonConstraints.size >= 2) {
                // AND-join: all non-epsilon and all distinct
                console.log(`  AND-join at ${vertex.id}: distinct C=[${[...nonEpsilonConstraints].join(', ')}]`);
                andJoins.push(vertex);
            } else if (hasEpsilon && nonEpsilonConstraints.size >= 1) {
                // MIX-join: mix of epsilon and non-epsilon
                console.log(`  MIX-join at ${vertex.id}: C=[${[...nonEpsilonConstraints].join(', ')}, ε]`);
                mixJoins.push(vertex);
            }
            // else: OR-join (all same C or all epsilon) - no special handling
        }

        return { andJoins, mixJoins };
    }

    /**
     * Combine multiple MinCS structures into one.
     * @param {Array<{vertices:Vertex[], edges:Edge[]}>} structures
     * @returns {{vertices:Vertex[], edges:Edge[]}}
     */
    static _combineStructures(structures) {
        const mergedVertices = new Map();
        const mergedEdges = [];
        const edgeKeys = new Set();

        for (const s of structures) {
            s.vertices.forEach(v => mergedVertices.set(v.id, v));
            s.edges.forEach(e => {
                const key = `${e.from.id}→${e.to.id}`;
                if (!edgeKeys.has(key)) {
                    edgeKeys.add(key);
                    mergedEdges.push(e);
                }
            });
        }

        return {
            vertices: Array.from(mergedVertices.values()),
            edges: mergedEdges
        };
    }

    /**
     * Merge MinCS structures based on join semantics.
     * 
     * - AND-join: MERGE all paths through the join (replace individuals with combined)
     * - MIX-join: KEEP individuals AND ADD combined version
     * - OR-join: Keep as-is (no merging)
     *
     * @param {Graph} rdlt - The RDLT graph
     * @param {Array<{vertices:Vertex[], edges:Edge[]}>} structures - MinCS list
     * @returns {Array<{vertices:Vertex[], edges:Edge[]}>} - Adjusted structures
     */
    static _mergeByJoinType(rdlt, structures) {
        console.log(`[MCA] Phase 3: Join-based merging (${structures.length} initial structures)`);
        
        const { andJoins, mixJoins } = this._classifyJoinVertices(rdlt);

        if (andJoins.length === 0 && mixJoins.length === 0) {
            console.log(`[MCA] No AND/MIX joins found - no merging needed`);
            return structures;
        }

        let result = [...structures];

        // Handle AND-joins: merge all paths through the join into ONE structure
        for (const joinVertex of andJoins) {
            const passingThrough = result.filter(s =>
                s.vertices.some(v => v.id === joinVertex.id)
            );

            console.log(`[MCA] AND-join ${joinVertex.id}: ${passingThrough.length} structures pass through`);

            if (passingThrough.length > 1) {
                const combined = this._combineStructures(passingThrough);
                console.log(`[MCA]   Merged ${passingThrough.length} → 1 (${combined.vertices.length} vertices, ${combined.edges.length} edges)`);

                // Replace individuals with the merged one
                result = result.filter(s => !passingThrough.includes(s));
                result.push(combined);
            }
        }

        // Handle MIX-joins: keep individuals AND add combined version
        for (const joinVertex of mixJoins) {
            const passingThrough = result.filter(s =>
                s.vertices.some(v => v.id === joinVertex.id)
            );

            console.log(`[MCA] MIX-join ${joinVertex.id}: ${passingThrough.length} structures pass through`);

            if (passingThrough.length > 1) {
                const combined = this._combineStructures(passingThrough);
                const combinedKey = this._minCSKey(combined);

                // Only add if not already present
                const existingKeys = result.map(s => this._minCSKey(s));
                if (!existingKeys.includes(combinedKey)) {
                    console.log(`[MCA]   Added combined structure (${combined.vertices.length} vertices, ${combined.edges.length} edges)`);
                    result.push(combined);
                } else {
                    console.log(`[MCA]   Combined structure already exists`);
                }
            }
        }

        console.log(`[MCA] After join merging: ${result.length} structures`);
        return result;
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Looping-arc detection
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Edge (fromId → toId) is a looping arc if there exists a directed path
     * from toId back to fromId in the FULL edge list.
     */
    static _isLoopingArc(allEdges, fromId, toId) {
        return this._hasPath(allEdges, toId, fromId, new Set());
    }

    static _hasPath(allEdges, cur, target, visited) {
        if (cur === target) return true;
        if (visited.has(cur)) return false;
        visited.add(cur);
        for (const e of allEdges) {
            if (e.from.id === cur) {
                if (this._hasPath(allEdges, e.to.id, target, visited)) return true;
            }
        }
        return false;
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Misc utilities
    // ══════════════════════════════════════════════════════════════════════

    /** Normalise a C-attribute: any epsilon variant → '' (empty string). */
    static _nc(c) {
        if (!c || c === 'ε' || c === 'epsilon' || c === 'Ɛ' || c === '\u03b5') return '';
        return c;
    }

    /** Stable deduplication key for a MinCS. */
    static _minCSKey(minCS) {
        const vs = minCS.vertices.map(v => v.id).sort().join(',');
        const es = minCS.edges.map(e => `${e.from.id}→${e.to.id}`).sort().join('|');
        return `V:[${vs}]E:[${es}]`;
    }


    // ══════════════════════════════════════════════════════════════════════
    //  Backward-compatible shim
    // ══════════════════════════════════════════════════════════════════════

    /**
     * @deprecated  Use getAllMinCS() instead.
     */
    static extractMinimalContractionPath(R, sourceId, sinkId, level = 1) {
        console.warn('[MCA] extractMinimalContractionPath() is deprecated – use getAllMinCS()');
        const list = this.getAllMinCS(R, sourceId, sinkId);
        if (!list.length) return null;
        const g = new Graph();
        g.vertices = list[0].vertices;
        g.edges    = list[0].edges;
        return g;
    }
}