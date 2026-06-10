"""AGNES hierarchical clustering via scipy + incremental insert.

Port of TS `clustering.ts`. scipy's `linkage` matrix is converted to a
dendrogram structure (similar to ml-hclust's AGNES output), then cut at
`1 - similarity_threshold` and capped at `max_depth` to produce a
`ClusterNode` tree.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from scipy.cluster.hierarchy import linkage

from .labeler import generate_label
from .mindmap_types import (
    ClusterNode,
    ConversationItem,
    MindmapConfig,
    StoreStats,
    StoreState,
)

logger = logging.getLogger("plugins.context_engine.contexto")


@dataclass
class _Dendro:
    """Minimal dendrogram node. Mirrors ml-hclust's AgnesCluster surface."""
    is_leaf: bool
    index: int  # original-observation index when is_leaf=True, else -1
    height: float
    children: tuple["_Dendro", "_Dendro"] | None = None


def _build_dendrogram(Z: np.ndarray, n: int) -> _Dendro:
    """Convert scipy's (n-1)x4 linkage matrix into a binary dendrogram tree.

    Iterative bottom-up to avoid recursion limit on degenerate chains.
    """
    nodes: list[_Dendro] = [_Dendro(is_leaf=True, index=i, height=0.0) for i in range(n)]
    for row in Z:
        a_idx = int(row[0])
        b_idx = int(row[1])
        d = float(row[2])
        nodes.append(
            _Dendro(
                is_leaf=False,
                index=-1,
                height=d,
                children=(nodes[a_idx], nodes[b_idx]),
            )
        )
    return nodes[-1]


def _collect_leaves(node: _Dendro, items: list[ConversationItem]) -> list[ConversationItem]:
    """Iterative DFS over the dendrogram. Avoids stack overflow on long chains."""
    result: list[ConversationItem] = []
    stack: list[_Dendro] = [node]
    while stack:
        cur = stack.pop()
        if cur.is_leaf:
            result.append(items[cur.index])
        elif cur.children is not None:
            # push in order so left subtree is processed first
            stack.append(cur.children[1])
            stack.append(cur.children[0])
    return result


def _average_centroid(embeddings: list[list[float]]) -> list[float]:
    if not embeddings:
        return []
    arr = np.asarray(embeddings, dtype=np.float64)
    return arr.mean(axis=0).tolist()


def _update_centroid(centroid: list[float], prev_count: int, new_embedding: list[float]) -> list[float]:
    """Streaming mean update. Mirrors TS updateCentroid."""
    if prev_count <= 0 or not centroid:
        return list(new_embedding)
    if len(centroid) != len(new_embedding):
        return list(new_embedding)
    new_count = prev_count + 1
    return [
        (c * prev_count + e) / new_count
        for c, e in zip(centroid, new_embedding)
    ]


def _cosine_sim(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    arr_a = np.asarray(a, dtype=np.float64)
    arr_b = np.asarray(b, dtype=np.float64)
    na = float(np.linalg.norm(arr_a))
    nb = float(np.linalg.norm(arr_b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(arr_a @ arr_b / (na * nb))


def _count_clusters(node: ClusterNode) -> int:
    """Recursive cluster count. Mirrors TS countClusters."""
    count = 1 if (node.children or node.items) else 0
    for child in node.children:
        count += _count_clusters(child)
    return count


def _collect_items(node: ClusterNode) -> list[ConversationItem]:
    """Gather all items under `node`. Iterative."""
    result: list[ConversationItem] = []
    stack: list[ClusterNode] = [node]
    while stack:
        cur = stack.pop()
        result.extend(cur.items)
        for child in cur.children:
            stack.append(child)
    return result


class Clusterer:
    """Stateful (per-mindmap) cluster builder."""

    def __init__(self, config: MindmapConfig) -> None:
        self._config = config
        # Plain int (not itertools.count) so we can fast-forward past whatever
        # the loaded state already used — see _seed_counter_from.
        self._next_id = 1

    # ---- public API -------------------------------------------------------
    def add(self, state: StoreState, items: list[ConversationItem]) -> StoreState:
        """Add `items` to `state`, choosing between full rebuild and incremental insert.

        Rebuild when `new_total < 100` OR
        `inserts_since_rebuild + len(items) >= rebuild_interval`.
        Matches TS addToMindmap.
        """
        if not items:
            return state

        # Seed the counter past whatever the loaded tree already used so a new
        # incremental insert cannot reuse an existing id (e.g. cluster-1 again
        # after restart). Idempotent: a no-op when we're already ahead.
        if state.root is not None:
            self._seed_counter_from(state.root)

        cur_total = state.stats.total_items
        new_total = cur_total + len(items)
        should_rebuild = (
            new_total < 100
            or state.stats.inserts_since_rebuild + len(items) >= self._config.rebuild_interval
        )

        if should_rebuild:
            all_items = _collect_items(state.root) if state.root is not None else []
            all_items.extend(items)
            new_root = self._build(all_items)
            return StoreState(
                version=state.version,
                config_snapshot=state.config_snapshot,
                root=new_root,
                stats=StoreStats(
                    total_items=len(all_items),
                    total_clusters=_count_clusters(new_root),
                    inserts_since_rebuild=0,
                ),
            )

        # Incremental — mutates state.root in place (TS does the same).
        # Ensure root exists.
        if state.root is None:
            new_root = self._build(list(items))
            return StoreState(
                version=state.version,
                config_snapshot=state.config_snapshot,
                root=new_root,
                stats=StoreStats(
                    total_items=len(items),
                    total_clusters=_count_clusters(new_root),
                    inserts_since_rebuild=0,
                ),
            )

        for item in items:
            self._incremental_insert(state.root, item)

        return StoreState(
            version=state.version,
            config_snapshot=state.config_snapshot,
            root=state.root,
            stats=StoreStats(
                total_items=new_total,
                total_clusters=_count_clusters(state.root),
                inserts_since_rebuild=state.stats.inserts_since_rebuild + len(items),
            ),
        )

    # ---- build (rebuild) --------------------------------------------------
    def _build(self, items: list[ConversationItem]) -> ClusterNode:
        if len(items) == 0:
            return ClusterNode(
                id="root", label="Knowledge", centroid=[], children=[], items=[],
                depth=0, item_count=0,
            )

        if len(items) == 1:
            it = items[0]
            leaf = ClusterNode(
                id=self._new_id(),
                label=generate_label([it], it.embedding),
                centroid=list(it.embedding),
                children=[],
                items=[it],
                depth=1,
                item_count=1,
            )
            return ClusterNode(
                id="root",
                label="Knowledge",
                centroid=list(it.embedding),
                children=[leaf],
                items=[],
                depth=0,
                item_count=1,
            )

        # scipy.linkage with method='average' + metric='cosine'.
        embeddings = np.asarray([it.embedding for it in items], dtype=np.float64)
        if not np.isfinite(embeddings).all():
            raise ValueError("embeddings contain non-finite values")
        if (np.linalg.norm(embeddings, axis=1) == 0.0).any():
            # Cosine distance is undefined for zero vectors — scipy emits NaN,
            # which would silently merge everything at distance 0 below.
            raise ValueError("embeddings contain zero vectors")
        Z = linkage(embeddings, method="average", metric="cosine")
        # Identical points can yield tiny negative distances (float error);
        # clamp those and any residual NaNs to 0. (Index/count columns are
        # non-negative, so a whole-matrix clamp is safe.)
        Z = np.where(np.isnan(Z) | (Z < 0.0), 0.0, Z)
        tree = _build_dendrogram(Z, len(items))

        distance_threshold = 1.0 - self._config.similarity_threshold

        # If the root merge is below threshold, everything is one cluster.
        if tree.height <= distance_threshold:
            centroid = _average_centroid([it.embedding for it in items])
            single = ClusterNode(
                id=self._new_id(),
                label=generate_label(items, centroid),
                centroid=centroid,
                children=[],
                items=list(items),
                depth=1,
                item_count=len(items),
            )
            return ClusterNode(
                id="root",
                label="Knowledge",
                centroid=centroid,
                children=[single],
                items=[],
                depth=0,
                item_count=len(items),
            )

        # Walk the dendrogram, cutting at distance_threshold and depth cap.
        top_children: list[ClusterNode] = []
        assert tree.children is not None
        for child in tree.children:
            if child.is_leaf:
                top_children.append(self._dendro_to_tree(child, items, depth=1))
            elif child.height > distance_threshold and 2 < self._config.max_depth:
                top_children.append(self._dendro_to_tree(child, items, depth=1))
            else:
                leaf_items = _collect_leaves(child, items)
                centroid = _average_centroid([i.embedding for i in leaf_items])
                top_children.append(ClusterNode(
                    id=self._new_id(),
                    label=generate_label(leaf_items, centroid),
                    centroid=centroid,
                    children=[],
                    items=leaf_items,
                    depth=1,
                    item_count=len(leaf_items),
                ))

        all_items: list[ConversationItem] = []
        for c in top_children:
            all_items.extend(_collect_items(c))
        root_centroid = _average_centroid([i.embedding for i in all_items])
        return ClusterNode(
            id="root",
            label="Knowledge",
            centroid=root_centroid,
            children=top_children,
            items=[],
            depth=0,
            item_count=len(all_items),
        )

    def _dendro_to_tree(
        self,
        agnes_node: _Dendro,
        items: list[ConversationItem],
        depth: int,
    ) -> ClusterNode:
        """Walk one subtree of the dendrogram into a ClusterNode. Recursion bounded by max_depth."""
        if agnes_node.is_leaf:
            it = items[agnes_node.index]
            return ClusterNode(
                id=self._new_id(),
                label=generate_label([it], it.embedding),
                centroid=list(it.embedding),
                children=[],
                items=[it],
                depth=depth,
                item_count=1,
            )

        assert agnes_node.children is not None
        distance_threshold = 1.0 - self._config.similarity_threshold
        child_nodes: list[ClusterNode] = []
        for child in agnes_node.children:
            if child.is_leaf:
                child_nodes.append(self._dendro_to_tree(child, items, depth + 1))
            elif child.height <= distance_threshold or depth + 1 >= self._config.max_depth:
                leaf_items = _collect_leaves(child, items)
                centroid = _average_centroid([i.embedding for i in leaf_items])
                child_nodes.append(ClusterNode(
                    id=self._new_id(),
                    label=generate_label(leaf_items, centroid),
                    centroid=centroid,
                    children=[],
                    items=leaf_items,
                    depth=depth + 1,
                    item_count=len(leaf_items),
                ))
            else:
                child_nodes.append(self._dendro_to_tree(child, items, depth + 1))

        all_items: list[ConversationItem] = []
        for c in child_nodes:
            all_items.extend(_collect_items(c))
        centroid = _average_centroid([i.embedding for i in all_items])
        return ClusterNode(
            id=self._new_id(),
            label=generate_label(all_items, centroid),
            centroid=centroid,
            children=child_nodes,
            items=[],
            depth=depth,
            item_count=len(all_items),
        )

    # ---- incremental insert ----------------------------------------------
    def _incremental_insert(self, node: ClusterNode, item: ConversationItem) -> None:
        """Descend, choosing the best-similarity child; create new child if none qualifies.

        Iterative (bounded by max_depth anyway). Updates centroids on the visited path.
        """
        path: list[ClusterNode] = [node]
        while True:
            current = path[-1]
            current.item_count += 1

            if not current.children:
                # Leaf-ish — drop the item here.
                prev_count = len(current.items)
                current.items.append(item)
                current.centroid = _update_centroid(
                    current.centroid, prev_count, item.embedding
                )
                current.label = generate_label(current.items, current.centroid)
                break

            # Score children by cosine sim to item.embedding
            best_child: ClusterNode | None = None
            best_sim = -1.0
            for child in current.children:
                sim = _cosine_sim(item.embedding, child.centroid)
                if sim > best_sim:
                    best_sim = sim
                    best_child = child

            if (
                best_child is not None
                and best_sim >= self._config.similarity_threshold
                and best_child.depth < self._config.max_depth
            ):
                # Update current centroid on the way down (matches TS).
                current.centroid = _update_centroid(
                    current.centroid, current.item_count - 1, item.embedding
                )
                path.append(best_child)
                continue

            # No good match — create a new child cluster under current.
            current.children.append(ClusterNode(
                id=self._new_id(),
                label=generate_label([item], item.embedding),
                centroid=list(item.embedding),
                children=[],
                items=[item],
                depth=current.depth + 1,
                item_count=1,
            ))
            current.centroid = _update_centroid(
                current.centroid, current.item_count - 1, item.embedding
            )
            break

    def _new_id(self) -> str:
        cid = f"cluster-{self._next_id}"
        self._next_id += 1
        return cid

    def _seed_counter_from(self, root: ClusterNode) -> None:
        """Push `_next_id` past the largest `cluster-N` already in the tree.

        Guards against ID collisions when a persisted state is reloaded and the
        next operation is an incremental insert (which would otherwise restart
        the counter at 1 and produce a duplicate id under root).
        """
        max_n = 0
        stack: list[ClusterNode] = [root]
        while stack:
            node = stack.pop()
            if node.id.startswith("cluster-"):
                try:
                    n = int(node.id.split("-", 1)[1])
                except (ValueError, IndexError):
                    n = 0
                if n > max_n:
                    max_n = n
            stack.extend(node.children)
        if self._next_id <= max_n:
            self._next_id = max_n + 1


__all__ = ["Clusterer"]
