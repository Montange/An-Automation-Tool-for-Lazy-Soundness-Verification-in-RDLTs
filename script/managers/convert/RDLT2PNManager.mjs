import VisualRDLTModel from "../../entities/model/visual/VisualRDLTModel.mjs";
import { generateUniqueID } from "../../utils.mjs";
import ModelContext from "../model/ModelContext.mjs";
import { verifySoundness } from "../../services/soundness/soundness-service.mjs";

export class RDLT2PNManager {
    /** @type {ModelContext} */
    context;

    /** @type {string} */
    id;

    /** @type {VisualRDLTModel} */
    #modelSnapshot;

    /**
     * @param {ModelContext} context
     * @param {*} visualModelSnapshot
     */
    constructor(context, visualModelSnapshot) {
        this.context = context;
        this.id = generateUniqueID();
        this.#modelSnapshot = visualModelSnapshot;

        this.#initialize();
    }

    async #initialize() {
        const subworkspaceTabManager = await this.context.managers.workspace.addRDLT2PNSubworkspace(this.id);
        const rootElement = subworkspaceTabManager.tabAreaElement;

        const simpleModel = this.#modelSnapshot.toSimpleModel();
        const iframe = rootElement.querySelector("iframe");
        const jsonInput = {
            vertices: simpleModel.components.map(vertex => ({
                id: vertex.identifier,
                type: vertex.type.charAt(0),
                label: '',
                M: vertex.isRBSCenter ? 1 : 0,
            })),
            edges: simpleModel.arcs.map(edge => ({
                from: simpleModel.components.filter(v => v.uid === edge.fromVertexUID)[0].identifier,
                to: simpleModel.components.filter(v => v.uid === edge.toVertexUID)[0].identifier,
                C: edge.C === '' ? 'ϵ' : edge.C,
                L: edge.L,
            }))
        };

        // Run LRSVA automatically at conversion time so the PN behavioral report
        // always has the correct lazy soundness result, regardless of whether the
        // user ran the Verifications panel first.
        const rdltLazySoundPass = this.#runLRSVA(simpleModel);

        iframe.addEventListener("load", () => {
            console.log(simpleModel);
            console.log(jsonInput);
            console.log('[RDLT2PNManager] rdltLazySoundPass:', rdltLazySoundPass);
            iframe.contentWindow.renderConversion(jsonInput, rdltLazySoundPass);
        });
    }

    /**
     * Runs lazy soundness verification (LRSVA) on the model snapshot.
     * Automatically detects source and sink as the unique no-incoming / no-outgoing vertices.
     * Returns true if lazy sound, false if not, null if source/sink cannot be determined.
     *
     * @param {object} simpleModel
     * @returns {boolean|null}
     */
    #runLRSVA(simpleModel) {
        try {
            const sources = this.#modelSnapshot.getPotentialSourceVertices();
            const sinks   = this.#modelSnapshot.getPotentialSinkVertices();

            if (sources.length === 0 || sinks.length === 0) {
                console.warn('[RDLT2PNManager] Cannot run LRSVA: no source or sink found.');
                return null;
            }

            // Use the first source and sink (same convention as the Verifications panel).
            const sourceUID = sources[0].uid;
            const sinkUID   = sinks[0].uid;

            const result = verifySoundness(simpleModel, sourceUID, sinkUID, 'lazy');
            const pass = result?.instances?.[0]?.evaluation?.conclusion?.pass ?? null;
            console.log('[RDLT2PNManager] LRSVA result:', pass);
            return pass;
        } catch (err) {
            console.error('[RDLT2PNManager] LRSVA failed during conversion:', err);
            return null;
        }
    }
}