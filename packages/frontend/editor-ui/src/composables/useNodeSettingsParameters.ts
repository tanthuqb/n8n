import get from 'lodash/get';
import set from 'lodash/set';
import { ref } from 'vue';
import {
	type INode,
	type INodeParameters,
	type INodeProperties,
	type NodeParameterValue,
	NodeHelpers,
	deepCopy,
} from 'n8n-workflow';
import { useTelemetry } from './useTelemetry';
import { useNodeHelpers } from './useNodeHelpers';
import { useWorkflowHelpers } from './useWorkflowHelpers';
import { useCanvasOperations } from './useCanvasOperations';
import { useExternalHooks } from './useExternalHooks';
import type { INodeUi, IUpdateInformation } from '@/Interface';
import {
	mustHideDuringCustomApiCall,
	updateDynamicConnections,
	updateParameterByPath,
} from '@/utils/nodeSettingsUtils';
import { useNodeTypesStore } from '@/stores/nodeTypes.store';
import { useFocusPanelStore } from '@/stores/focusPanel.store';
import { useNDVStore } from '@/stores/ndv.store';
import { useWorkflowsStore } from '@/stores/workflows.store';
import { KEEP_AUTH_IN_NDV_FOR_NODES } from '@/constants';
import { omitKey } from '@/utils/objectUtils';
import {
	getMainAuthField,
	getNodeAuthFields,
	isAuthRelatedParameter,
} from '@/utils/nodeTypesUtils';

export function useNodeSettingsParameters() {
	const workflowsStore = useWorkflowsStore();
	const nodeTypesStore = useNodeTypesStore();
	const telemetry = useTelemetry();
	const nodeHelpers = useNodeHelpers();
	const workflowHelpers = useWorkflowHelpers();
	const canvasOperations = useCanvasOperations();
	const externalHooks = useExternalHooks();

	const nodeValues = ref<INodeParameters>({
		color: '#ff0000',
		alwaysOutputData: false,
		executeOnce: false,
		notesInFlow: false,
		onError: 'stopWorkflow',
		retryOnFail: false,
		maxTries: 3,
		waitBetweenTries: 1000,
		notes: '',
		parameters: {},
	});

	function setValue(name: string, value: NodeParameterValue) {
		const nameParts = name.split('.');
		let lastNamePart: string | undefined = nameParts.pop();

		let isArray = false;
		if (lastNamePart?.includes('[')) {
			// It includes an index so we have to extract it
			const lastNameParts = lastNamePart.match(/(.*)\[(\d+)\]$/);
			if (lastNameParts) {
				nameParts.push(lastNameParts[1]);
				lastNamePart = lastNameParts[2];
				isArray = true;
			}
		}

		// Set the value so that everything updates correctly in the UI
		if (nameParts.length === 0) {
			// Data is on top level
			if (value === null) {
				// Property should be deleted
				if (lastNamePart) {
					nodeValues.value = omitKey(nodeValues.value, lastNamePart);
				}
			} else {
				// Value should be set
				nodeValues.value = {
					...nodeValues.value,
					[lastNamePart as string]: value,
				};
			}
		} else {
			// Data is on lower level
			if (value === null) {
				// Property should be deleted
				let tempValue = get(nodeValues.value, nameParts.join('.')) as
					| INodeParameters
					| INodeParameters[];

				if (lastNamePart && !Array.isArray(tempValue)) {
					tempValue = omitKey(tempValue, lastNamePart);
				}

				if (isArray && Array.isArray(tempValue) && tempValue.length === 0) {
					// If a value from an array got delete and no values are left
					// delete also the parent
					lastNamePart = nameParts.pop();
					tempValue = get(nodeValues.value, nameParts.join('.')) as INodeParameters;
					if (lastNamePart) {
						tempValue = omitKey(tempValue, lastNamePart);
					}
				}
			} else {
				// Value should be set
				if (typeof value === 'object') {
					set(
						get(nodeValues.value, nameParts.join('.')) as Record<string, unknown>,
						lastNamePart as string,
						deepCopy(value),
					);
				} else {
					set(
						get(nodeValues.value, nameParts.join('.')) as Record<string, unknown>,
						lastNamePart as string,
						value,
					);
				}
			}
		}

		nodeValues.value = { ...nodeValues.value };
	}

	function updateNodeParameter(
		parameterData: IUpdateInformation & { name: `parameters.${string}` },
		newValue: NodeParameterValue,
		node: INode,
		isToolNode: boolean,
	) {
		const nodeTypeDescription = nodeTypesStore.getNodeType(node.type, node.typeVersion);
		if (!nodeTypeDescription) {
			return;
		}

		// Get only the parameters which are different to the defaults
		let nodeParameters = NodeHelpers.getNodeParameters(
			nodeTypeDescription.properties,
			node.parameters,
			false,
			false,
			node,
			nodeTypeDescription,
		);

		const oldNodeParameters = Object.assign({}, nodeParameters);

		// Copy the data because it is the data of vuex so make sure that
		// we do not edit it directly
		nodeParameters = deepCopy(nodeParameters);

		const parameterPath = updateParameterByPath(
			parameterData.name,
			newValue,
			nodeParameters,
			nodeTypeDescription,
			node.typeVersion,
		);

		// Get the parameters with the now new defaults according to the
		// from the user actually defined parameters
		nodeParameters = NodeHelpers.getNodeParameters(
			nodeTypeDescription.properties,
			nodeParameters as INodeParameters,
			true,
			false,
			node,
			nodeTypeDescription,
		);

		if (isToolNode) {
			const updatedDescription = NodeHelpers.getUpdatedToolDescription(
				nodeTypeDescription,
				nodeParameters,
				node.parameters,
			);

			if (updatedDescription && nodeParameters) {
				nodeParameters.toolDescription = updatedDescription;
			}
		}

		if (NodeHelpers.isDefaultNodeName(node.name, nodeTypeDescription, node.parameters ?? {})) {
			const newName = NodeHelpers.makeNodeName(nodeParameters ?? {}, nodeTypeDescription);
			// Account for unique-ified nodes with `<name><digit>`
			if (!node.name.startsWith(newName)) {
				// We need a timeout here to support events reacting to the valueChange based on node names
				setTimeout(async () => await canvasOperations.renameNode(node.name, newName));
			}
		}

		for (const [key, value] of Object.entries(nodeParameters as object)) {
			if (value !== null && value !== undefined) {
				setValue(`parameters.${key}`, value as string);
			}
		}

		// Update the data in vuex
		const updateInformation: IUpdateInformation = {
			name: node.name,
			value: nodeParameters,
		};

		const connections = workflowsStore.allConnections;

		const updatedConnections = updateDynamicConnections(node, connections, parameterData);

		if (updatedConnections) {
			workflowsStore.setConnections(updatedConnections, true);
		}

		workflowsStore.setNodeParameters(updateInformation);

		void externalHooks.run('nodeSettings.valueChanged', {
			parameterPath,
			newValue,
			parameters: nodeTypeDescription.properties,
			oldNodeParameters,
		});

		nodeHelpers.updateNodeParameterIssuesByName(node.name);
		nodeHelpers.updateNodeCredentialIssuesByName(node.name);
		telemetry.trackNodeParametersValuesChange(nodeTypeDescription.name, parameterData);
	}

	function handleFocus(node: INodeUi | undefined, path: string, parameter: INodeProperties) {
		if (!node) return;

		const ndvStore = useNDVStore();
		const focusPanelStore = useFocusPanelStore();

		focusPanelStore.openWithFocusedNodeParameter({
			nodeId: node.id,
			parameterPath: path,
			parameter,
		});

		if (ndvStore.activeNode) {
			ndvStore.setActiveNodeName(null);
			ndvStore.resetNDVPushRef();
		}
	}

	function shouldDisplayNodeParameter(
		nodeParameters: INodeParameters,
		node: INodeUi | null,
		parameter: INodeProperties,
		path: string | undefined = '',
		displayKey: 'displayOptions' | 'disabledOptions' = 'displayOptions',
	): boolean {
		if (parameter.type === 'hidden') {
			return false;
		}

		if (
			nodeHelpers.isCustomApiCallSelected(nodeParameters) &&
			mustHideDuringCustomApiCall(parameter, nodeParameters)
		) {
			return false;
		}

		const nodeType = !node ? null : nodeTypesStore.getNodeType(node.type, node.typeVersion);

		// TODO: For now, hide all fields that are used in authentication fields displayOptions
		// Ideally, we should check if any non-auth field depends on it before hiding it but
		// since there is no such case, omitting it to avoid additional computation
		const shouldHideAuthRelatedParameter = isAuthRelatedParameter(
			getNodeAuthFields(nodeType),
			parameter,
		);

		const mainNodeAuthField = getMainAuthField(nodeType);

		// Hide authentication related fields since it will now be part of credentials modal
		if (
			!KEEP_AUTH_IN_NDV_FOR_NODES.includes(node?.type ?? '') &&
			mainNodeAuthField &&
			(parameter.name === mainNodeAuthField.name || shouldHideAuthRelatedParameter)
		) {
			return false;
		}

		if (parameter[displayKey] === undefined) {
			// If it is not defined no need to do a proper check
			return true;
		}

		const nodeParams: INodeParameters = {};
		let rawValues = nodeParameters;
		if (path) {
			rawValues = get(nodeParameters, path) as INodeParameters;
		}

		if (!rawValues) {
			return false;
		}
		// Resolve expressions
		const resolveKeys = Object.keys(rawValues);
		let key: string;
		let i = 0;
		let parameterGotResolved = false;
		do {
			key = resolveKeys.shift() as string;
			const value = rawValues[key];
			if (typeof value === 'string' && value?.charAt(0) === '=') {
				// Contains an expression that
				if (
					value.includes('$parameter') &&
					resolveKeys.some((parameterName) => value.includes(parameterName))
				) {
					// Contains probably an expression of a missing parameter so skip
					resolveKeys.push(key);
					continue;
				} else {
					// Contains probably no expression with a missing parameter so resolve
					try {
						nodeParams[key] = workflowHelpers.resolveExpression(
							value,
							nodeParams,
						) as NodeParameterValue;
					} catch {
						// If expression is invalid ignore
						nodeParams[key] = '';
					}
					parameterGotResolved = true;
				}
			} else {
				// Does not contain an expression, add directly
				nodeParams[key] = rawValues[key];
			}
			// TODO: Think about how to calculate this best
			if (i++ > 50) {
				// Make sure we do not get caught
				break;
			}
		} while (resolveKeys.length !== 0);

		if (parameterGotResolved) {
			if (path) {
				rawValues = deepCopy(nodeParameters);
				set(rawValues, path, nodeParams);
				return nodeHelpers.displayParameter(rawValues, parameter, path, node, displayKey);
			} else {
				return nodeHelpers.displayParameter(nodeParams, parameter, '', node, displayKey);
			}
		}

		return nodeHelpers.displayParameter(nodeParameters, parameter, path, node, displayKey);
	}

	return {
		nodeValues,
		setValue,
		shouldDisplayNodeParameter,
		updateParameterByPath,
		updateNodeParameter,
		handleFocus,
	};
}
