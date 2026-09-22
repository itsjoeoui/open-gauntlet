"""Flat storage with two trie indexes and per-user quotas.

Assumptions where the prompt is silent:
- Copies preserve source ownership and fail if the resulting usage exceeds quota.
- Compression fails if its destination name already exists.
Inputs satisfy the prompt's size/capacity constraints.
"""

from __future__ import annotations

import heapq
from collections.abc import Iterator
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class File:
    name: str
    size: int
    owner: str | None = None


@dataclass(slots=True)
class User:
    capacity: int
    usage: int = 0
    filenames: set[str] = field(default_factory=set)

    @property
    def remaining(self) -> int:
        return self.capacity - self.usage


@dataclass(slots=True)
class TrieNode:
    children: dict[str, TrieNode] = field(default_factory=dict)
    filename: str | None = None
    count: int = 0  # Number of live files in this subtree.


class Trie:
    def __init__(self) -> None:
        self.root: TrieNode = TrieNode()

    def add(self, key: str, filename: str) -> None:
        """Insert a new key. CloudStorage guarantees that it is absent."""
        node = self.root
        node.count += 1
        for char in key:
            if char not in node.children:
                node.children[char] = TrieNode()
            node = node.children[char]
            node.count += 1
        node.filename = filename

    def remove(self, key: str) -> None:
        """Remove an existing key and prune unused branches."""
        node = self.root
        path: list[tuple[TrieNode, str]] = []
        for char in key:
            path.append((node, char))
            node = node.children[char]

        node.filename = None
        node.count -= 1
        for parent, char in reversed(path):
            child = parent.children[char]
            if child.count == 0:
                del parent.children[char]
            parent.count -= 1

    def get(self, prefix: str) -> TrieNode | None:
        node = self.root
        for char in prefix:
            node = node.children.get(char)
            if node is None:
                return None
        return node

    @staticmethod
    def filenames(node: TrieNode) -> Iterator[str]:
        stack = [node]
        while stack:
            current = stack.pop()
            if current.filename is not None:
                yield current.filename
            stack.extend(current.children.values())


class CloudStorage:
    COMPRESSED: str = ".compressed"

    def __init__(self) -> None:
        self.files: dict[str, File] = {}
        self.users: dict[str, User] = {}
        self.prefix_trie: Trie = Trie()
        self.suffix_trie: Trie = Trie()

    def _insert_file(self, file: File) -> None:
        """Commit a validated insertion into all bookkeeping structures."""
        name = file.name
        self.files[name] = file
        self.prefix_trie.add(name, name)
        self.suffix_trie.add(name[::-1], name)
        if file.owner is not None:
            user = self.users[file.owner]
            user.usage += file.size
            user.filenames.add(name)

    def _remove_file(self, name: str) -> None:
        file = self.files.pop(name)
        self.prefix_trie.remove(name)
        self.suffix_trie.remove(name[::-1])
        if file.owner is not None:
            user = self.users[file.owner]
            user.usage -= file.size
            user.filenames.remove(name)

    def _owned_file(self, user_id: str, name: str) -> File | None:
        file = self.files.get(name)
        if user_id not in self.users or file is None or file.owner != user_id:
            return None
        return file

    def add_file(self, name: str, size: int) -> bool:
        if name in self.files:
            return False
        self._insert_file(File(name, size))
        return True

    def get_file_size(self, name: str) -> int | None:
        file = self.files.get(name)
        return None if file is None else file.size

    def copy_file(self, name_from: str, name_to: str) -> bool:
        source = self.files.get(name_from)
        if source is None:
            return False
        if name_from == name_to:
            return True

        destination = self.files.get(name_to)
        if source.owner is not None:
            user = self.users[source.owner]
            # Replacing a file owned by this user releases some of their quota.
            released = (
                destination.size
                if destination is not None and destination.owner == source.owner
                else 0
            )
            if user.usage - released + source.size > user.capacity:
                return False

        # All checks passed: now commit the overwrite.
        if destination is not None:
            self._remove_file(name_to)
        self._insert_file(File(name_to, source.size, source.owner))
        return True

    def find_file(self, prefix: str, suffix: str) -> list[str]:
        if not prefix and not suffix:
            return heapq.nsmallest(
                10, self.files, key=lambda name: (-self.files[name].size, name)
            )

        prefix_node = self.prefix_trie.get(prefix)
        if prefix_node is None:
            return []
        suffix_node = self.suffix_trie.get(suffix[::-1])
        if suffix_node is None:
            return []

        # Enumerate the smaller candidate set, then check the other condition.
        if prefix_node.count <= suffix_node.count:
            candidates = (
                name for name in Trie.filenames(prefix_node) if name.endswith(suffix)
            )
        else:
            candidates = (
                name for name in Trie.filenames(suffix_node) if name.startswith(prefix)
            )
        return heapq.nsmallest(
            10, candidates, key=lambda name: (-self.files[name].size, name)
        )

    def add_user(self, user_id: str, capacity: int) -> bool:
        if user_id in self.users:
            return False
        self.users[user_id] = User(capacity)
        return True

    def add_file_by(self, user_id: str, name: str, size: int) -> int | None:
        user = self.users.get(user_id)
        if user is None or name in self.files or size > user.remaining:
            return None
        self._insert_file(File(name, size, user_id))
        return user.remaining

    def update_capacity(self, user_id: str, new_capacity: int) -> int | None:
        user = self.users.get(user_id)
        if user is None:
            return None
        user.capacity = new_capacity

        if user.usage > user.capacity:
            owned = sorted(
                user.filenames,
                key=lambda name: (self.files[name].size, name),
                reverse=True,
            )
            for name in owned:
                if user.usage <= user.capacity:
                    break
                self._remove_file(name)
        return user.remaining

    def compress_file(self, user_id: str, name: str) -> int | None:
        file = self._owned_file(user_id, name)
        target = name + self.COMPRESSED
        if file is None or name.endswith(self.COMPRESSED) or target in self.files:
            return None

        self._remove_file(name)
        self._insert_file(File(target, file.size // 2, user_id))
        return self.users[user_id].remaining

    def decompress_file(self, user_id: str, name: str) -> int | None:
        file = self._owned_file(user_id, name)
        if file is None or not name.endswith(self.COMPRESSED):
            return None
        target = name[: -len(self.COMPRESSED)]
        user = self.users[user_id]
        # Doubling the size requires only file.size additional bytes.
        if target in self.files or file.size > user.remaining:
            return None

        self._remove_file(name)
        self._insert_file(File(target, file.size * 2, user_id))
        return user.remaining
