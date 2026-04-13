import { parseRDLT } from './parser.js';
import { RDLTModel } from '../models/rdltModel.js';
import { preprocessRDLT, combineLevels } from './preprocessor.js';
import { mapToPetriNet } from './mapper.js';
import { structuralAnalysis } from './structuralAnalysis.js';
import { behavioralAnalysis } from './behavioralAnalysis.js';
import { Graph } from '../../../soundness/models/Graph.js';
import { Vertex } from '../../../soundness/models/Vertex.js';
import { Edge } from '../../../soundness/models/Edge.js';
import { Soundness } from '../../../soundness/utils/soundness.js';
import { utils } from '../../../soundness/utils/rdlt-utils.mjs';

/**
 * Convert an RDLTModel (rdlt2pn format) into a Graph (soundness format).
 * RDLTModel uses: nodes{id,type,label,M}, edges[{from,to,C,L}]
 * Graph uses:     vertices[Vertex{id,type,name}], edges[Edge{id,from,to,constraint,maxTraversals}]
 */
function rdltModelToGraph(rdltModel) {
  const graph = new Graph();
  const vertexMap = {};

  Object.values(rdltModel.nodes).forEach(n => {
    const v = new Vertex(n.id, n.type || 'c', {}, n.label || n.id);
    graph.vertices.push(v);
    vertexMap[n.id] = v;
  });

  rdltModel.edges.forEach((e, idx) => {
    const from = vertexMap[e.from];
    const to   = vertexMap[e.to];
    if (from && to) {
      const constraint = (!e.C || e.C === 'Ïµ' || e.C === 'ε' || e.C === 'epsilon') ? '' : e.C;
      graph.edges.push(new Edge(`e${idx}`, from, to, constraint, e.L || 1));
    }
  });

  return graph;
}

/**
 * Run LRSVA on the preprocessed R1/R2 models and persist the result
 * to localStorage so the PN conversion page can read it regardless
 * of whether the user ran lazy soundness verification first.
 */
function runLazySoundnessCheck(preprocessedModel) {
  try {
    const r1Graph = rdltModelToGraph(preprocessedModel.level1);
    const r2Graphs = Object.values(preprocessedModel.level2 || {})
      .map(m => rdltModelToGraph(m));
    const combinedEvsa = r2Graphs.length > 0 ? [r1Graph, ...r2Graphs] : [r1Graph];

    const { source, sink } = utils.getSourceAndSinkVertices(r1Graph);
    if (!source || !sink) return;

    const result = Soundness.checkLazySound(r1Graph, combinedEvsa);

    try {
      localStorage.setItem('rdlt:lazySoundResult', JSON.stringify({
        pass: result.pass,
        casCount: result.visualizationData?.casSet?.length ?? 0,
        message: result.message,
        timestamp: Date.now()
      }));
    } catch(e) {
      console.warn('[conversionFacade] localStorage unavailable:', e);
    }

    // Also fire CustomEvent for same-context listeners
    window.dispatchEvent(new CustomEvent('rdlt:lazySoundVerified', {
      detail: { pass: result.pass, message: result.message }
    }));

    console.log('[conversionFacade] Lazy soundness auto-check:', result.pass ? 'PASS' : 'FAIL');
  } catch(e) {
    console.warn('[conversionFacade] Lazy soundness auto-check failed:', e);
  }
}

export function convert(rdltInput, extend = true) {
  let parsedRDLT;
  try{
    // Step 1: Parse the RDLT input.
    parsedRDLT = parseRDLT(rdltInput, extend);
    console.log(`RDLT input parsed OK, with ${parsedRDLT.warnings.length===0?'0 warnings':`${parsedRDLT.warnings.length} warning(s). \n - ${parsedRDLT.warnings.join('\n - ')}`}`);
    // Step 2: Initialize RDLTModel from JSON using the static fromJSON method.
    const inputRdltModel = RDLTModel.fromJSON(parsedRDLT.rdltJSON);
    // Step 3: Preprocess the parsed RDLT model into level-1 and level-2 models.
    const preprocessedModel = preprocessRDLT(inputRdltModel, extend);
    // Step 4: Combine the two levels into one RDLT.
    const combinedRDLT = combineLevels(preprocessedModel.level1, preprocessedModel.level2);
    // Step 5: Map the preprocessed RDLT model to a Petri Net.
    const mappingResult = mapToPetriNet(combinedRDLT);
    const outputPnModel = mappingResult.petriNet;

    let payload = {
      rdlt: inputRdltModel, 
      preprocess: preprocessedModel, 
      combinedModel: combinedRDLT, 
      petriNet: outputPnModel,
      visualizeConversion: mappingResult.conversionDOT
    };
    // Only apply analysis if preprocessed RDLT is extended 
    if(!extend) {
      return { data: payload, warnings: parsedRDLT.warnings };
    }
    // Run structural analysis and behavioral analysis.
    payload.structAnalysis = structuralAnalysis(outputPnModel);
    payload.behaviorAnalysis = behavioralAnalysis(outputPnModel, 1000);

    // Run lazy soundness check automatically so the behavioral report
    // can show the preservation note regardless of whether the user
    // visited the lazy soundness panel first.
    runLazySoundnessCheck(preprocessedModel);

    return { data: payload, warnings: parsedRDLT.warnings };
  } catch (err) {
    return {
      error: err.message,
      warnings: parsedRDLT ? parsedRDLT.warnings : []
    };
  }
}