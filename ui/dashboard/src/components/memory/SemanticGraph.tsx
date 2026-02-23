'use client';

import { useEffect, useState, useCallback } from 'react';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import { apiService } from '@/lib/api';
import LoadingSkeleton from '@/components/ui/LoadingSkeleton';
import ErrorState from '@/components/ui/ErrorState';
import { GraphDetailsPanel } from './GraphDetailsPanel';

interface SemanticGraphProps {
  entity?: string;
  maxDepth?: number;
  maxNodes?: number;
  height?: number;
  agent?: string;
  userId?: string | null;
}

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  const nodeWidth = 180;
  const nodeHeight = 50;

  dagreGraph.setGraph({ rankdir: 'LR' }); // Left to Right layout

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
    };
  });

  return { nodes: layoutedNodes, edges };
};

export function SemanticGraph({ entity, maxDepth = 2, maxNodes = 50, height = 500, agent, userId }: SemanticGraphProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showDetailsPanel, setShowDetailsPanel] = useState(false);

  const fetchGraphData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiService.getGraphVisualization({ entity, maxDepth, maxNodes, agent, userId: userId ?? undefined });
      
      const initialNodes: Node[] = data.nodes.map((n) => ({
        id: n.id,
        data: { label: n.label },
        position: { x: 0, y: 0 }, // Layout will calculate real positions
        style: { 
          background: n.id === 'User' ? '#f0fdfa' : '#fff',
          border: n.id === 'User' ? '2px solid #0d9488' : '1px solid #78716c',
          borderRadius: '8px',
          padding: '10px',
          width: 180,
          fontSize: '12px',
          fontWeight: 500,
          color: '#1c1917',
          boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
        },
      }));

      const initialEdges: Edge[] = data.edges.map((e, i) => {
        const isHistorical = e.isHistorical ?? false;
        return {
          id: `e${i}`,
          source: e.source,
          target: e.target,
          label: e.predicate,
          type: 'smoothstep',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isHistorical ? '#9ca3af' : '#a8a29e',
          },
          style: { 
            stroke: isHistorical ? '#9ca3af' : '#a8a29e',
            strokeWidth: isHistorical ? 1 : 1.5,
            strokeDasharray: isHistorical ? '5,5' : undefined,
            opacity: isHistorical ? 0.5 : 1,
          },
          labelStyle: { 
            fill: isHistorical ? '#6b7280' : '#78716c', 
            fontSize: 10, 
            fontWeight: isHistorical ? 500 : 600 
          },
          labelBgStyle: { 
            fill: isHistorical ? '#f3f4f6' : '#fafaf9', 
            fillOpacity: isHistorical ? 0.6 : 0.8 
          },
        };
      });

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
        initialNodes,
        initialEdges
      );

      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load graph');
    } finally {
      setLoading(false);
    }
  }, [entity, maxDepth, maxNodes, agent, userId, setNodes, setEdges]);

  useEffect(() => {
    fetchGraphData();
  }, [fetchGraphData]);

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node.id);
    // Highlight selected node and connected edges
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        style: {
          ...n.style,
          border: n.id === node.id 
            ? '2px solid #f59e0b' // Amber for selected
            : n.id === 'User' 
              ? '2px solid #0d9488' 
              : '1px solid #78716c',
          boxShadow: n.id === node.id ? '0 0 0 4px rgba(245, 158, 11, 0.2)' : '0 4px 6px -1px rgb(0 0 0 / 0.1)',
        },
      }))
    );
  }, [setNodes]);

  if (loading) {
    return <LoadingSkeleton className="h-[500px] w-full rounded-xl" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={fetchGraphData} />;
  }

  if (!nodes.length) {
    return (
      <div className="h-[500px] w-full rounded-xl bg-white/50 border border-stone-100 flex items-center justify-center">
        <div className="text-center text-stone-500">
          <p className="text-sm font-medium">No semantic graph data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-stone-900">Semantic Knowledge Graph</h3>
          <p className="text-sm text-stone-600 mt-1">
            {nodes.length} entities, {edges.length} relationships
            {entity && ` • Centered on: ${entity}`}
          </p>
        </div>
        <button
          onClick={fetchGraphData}
          className="px-3 py-1.5 text-xs font-medium text-stone-700 bg-white border border-stone-200 rounded-lg hover:bg-stone-50 transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="bg-stone-50 rounded-xl border border-stone-200 overflow-hidden shadow-inner" style={{ height }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          fitView
          attributionPosition="bottom-right"
        >
          <Controls />
          <Background color="#d6d3d1" gap={16} />
        </ReactFlow>
      </div>

      {selectedNode && (
        <div className="mt-4 p-4 bg-teal-50 border border-teal-200 rounded-lg">
          <div className="flex items-start justify-between">
            <div>
              <h4 className="text-sm font-semibold text-teal-900 mb-2">Selected: {selectedNode}</h4>
              <button
                onClick={() => {
                  setSelectedNode(null);
                  // Reset styles
                  fetchGraphData(); 
                }}
                className="text-xs text-teal-700 hover:text-teal-900 underline"
              >
                Clear selection
              </button>
            </div>
            <button
              onClick={() => setShowDetailsPanel(true)}
              className="text-xs px-3 py-1.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 transition-colors"
            >
              View Details
            </button>
          </div>
        </div>
      )}

      {showDetailsPanel && selectedNode && (
        <>
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/20 z-40"
            onClick={() => {
              setShowDetailsPanel(false);
              setSelectedNode(null);
            }}
          />
          {/* Details Panel */}
          <GraphDetailsPanel
            entity={selectedNode}
            onClose={() => {
              setShowDetailsPanel(false);
              setSelectedNode(null);
            }}
            onChanged={() => {
              fetchGraphData();
            }}
          />
        </>
      )}
    </div>
  );
}
