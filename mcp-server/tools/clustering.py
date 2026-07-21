# NOTE: Heavy imports (pandas, sklearn, umap) deferred to function bodies
# for fast MCP startup (<2s). See config.py header for rationale.

from .config import save_csv, read_tabular


def cluster(
    path: str,
    columns: list[str],
    algorithm: str = "kmeans",
    n_clusters: int = 3,
    eps: float = 0.5,
    min_samples: int = 5,
):
    """Cluster data. algorithm: 'kmeans' or 'dbscan'."""
    try:
        from sklearn.preprocessing import StandardScaler
        from sklearn.cluster import KMeans, DBSCAN

        df = read_tabular(path)
        data = df[columns].dropna()

        if data.empty:
            return "Error: Selected columns contain only NaNs or are empty."

        scaler = StandardScaler()
        data_scaled = scaler.fit_transform(data)

        if algorithm == "kmeans":
            model = KMeans(n_clusters=n_clusters, random_state=42)
            labels = model.fit_predict(data_scaled)
            suffix = f"kmeans_{n_clusters}"

        elif algorithm == "dbscan":
            model = DBSCAN(eps=eps, min_samples=min_samples)
            labels = model.fit_predict(data_scaled)
            suffix = f"dbscan_{eps}_{min_samples}"

        else:
            return "Error: Algorithm must be 'kmeans' or 'dbscan'."

        df_new = df.copy()
        df_new.loc[data.index, f"cluster_{algorithm}"] = labels

        output_path = save_csv(df_new, path, suffix)

        counts = df_new[f"cluster_{algorithm}"].value_counts().to_dict()

        return {"output_path": output_path, "clusters": counts}

    except Exception as e:
        return f"Error clustering: {str(e)}"


def reduce_dimensions(
    path: str, columns: list[str], method: str = "pca", n_components: int = 2
):
    """Reduce dimensions. method: 'pca' or 'umap'."""
    try:
        from sklearn.preprocessing import StandardScaler
        from sklearn.decomposition import PCA

        df = read_tabular(path)
        data = df[columns].dropna()

        scaler = StandardScaler()
        data_scaled = scaler.fit_transform(data)

        info_msg = ""

        if method == "pca":
            # PCA (Principal Component Analysis)
            pca = PCA(n_components=n_components)
            components = pca.fit_transform(data_scaled)

            explained_variance = pca.explained_variance_ratio_.tolist()
            info_msg = f"Retained Info: {sum(explained_variance) * 100:.2f}%"
            suffix = f"pca_{n_components}"

        elif method == "umap":
            # UMAP (Uniform Manifold Approximation and Projection)
            try:
                import umap
            except ImportError:
                return "Error: 'umap-learn' library is not installed. Run 'uv add umap-learn'."

            reducer = umap.UMAP(n_components=n_components, random_state=42)
            components = reducer.fit_transform(data_scaled)

            info_msg = "UMAP preserves local neighbor structure."
            suffix = f"umap_{n_components}"

        else:
            return "Error: Method must be 'pca' or 'umap'."

        df_new = df.copy()
        for i in range(n_components):
            col_name = f"{method.upper()}{i + 1}"
            df_new.loc[data.index, col_name] = components[:, i]

        output_path = save_csv(df_new, path, suffix)

        return {"output_path": output_path}

    except Exception as e:
        return f"Error reducing dimensions: {str(e)}"
