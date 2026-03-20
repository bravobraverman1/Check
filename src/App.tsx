import { useState, useEffect, useCallback, ChangeEvent, FormEvent } from 'react';
import { Github, LogOut, Book, Star, GitFork, ExternalLink, RefreshCw, User as UserIcon, Layout, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string;
  bio: string;
  public_repos: number;
  followers: number;
  following: number;
  html_url: string;
}

interface Repository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  stargazers_count: number;
  forks_count: number;
  language: string;
  html_url: string;
  updated_at: string;
}

interface RepoContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: 'file' | 'dir';
  download_url: string | null;
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [targetRepoInput, setTargetRepoInput] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [diagnosticInfo, setDiagnosticInfo] = useState<any>(null);

  // Repo Explorer State
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoContents, setRepoContents] = useState<RepoContent[]>([]);
  const [currentPath, setCurrentPath] = useState('');
  const [isRepoLoading, setIsRepoLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);

  const checkAuthStatus = async () => {
    try {
      const [authRes, configRes] = await Promise.all([
        fetch('/api/auth/status', { credentials: 'include' }),
        fetch('/api/config/status', { credentials: 'include' })
      ]);
      const authData = await authRes.json();
      const configData = await configRes.json();
      
      setIsAuthenticated(authData.isAuthenticated);
      setIsConfigured(configData.isConfigured);
      
      if (authData.isAuthenticated) {
        fetchData();
      }
    } catch (err) {
      console.error('Failed to check status', err);
      setIsAuthenticated(false);
      setIsConfigured(false);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [userRes, reposRes] = await Promise.all([
        fetch('/api/github/user', { credentials: 'include' }),
        fetch('/api/github/repos', { credentials: 'include' })
      ]);

      if (!userRes.ok || !reposRes.ok) {
        const userErr = !userRes.ok ? await userRes.json().catch(() => ({})) : {};
        const reposErr = !reposRes.ok ? await reposRes.json().catch(() => ({})) : {};
        throw new Error(userErr.error || reposErr.error || 'Failed to fetch data');
      }

      const userData = await userRes.json();
      const reposData = await reposRes.json();

      setUser(userData);
      setRepos(reposData);
    } catch (err: any) {
      setError(err.message || 'Could not load GitHub data. Please try reconnecting.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuthStatus();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setIsAuthenticated(true);
        fetchData();
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleConnect = async () => {
    try {
      const res = await fetch('/api/auth/github/url', { credentials: 'include' });
      const { url } = await res.json();
      window.open(url, 'github_oauth', 'width=600,height=700');
    } catch (err) {
      alert('Failed to start GitHub connection');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    setIsAuthenticated(false);
    setUser(null);
    setRepos([]);
    setSelectedRepo(null);
    setRepoContents([]);
    setCurrentPath('');
  };

  const fetchRepoContents = async (repoFullName: string, path: string = '') => {
    setIsRepoLoading(true);
    setUploadStatus(null);
    try {
      const res = await fetch(`/api/github/repo/${repoFullName}/contents/${path}`, { credentials: 'include' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to fetch contents');
      }
      const data = await res.json();
      setRepoContents(Array.isArray(data) ? data : [data]);
      setSelectedRepo(repoFullName);
      setCurrentPath(path);
    } catch (err: any) {
      setError(err.message || 'Failed to load repository contents');
      console.error(err);
    } finally {
      setIsRepoLoading(false);
    }
  };

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !selectedRepo) return;

    setLoading(true);
    setUploadStatus(null);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64Content = (reader.result as string).split(',')[1];
        const path = currentPath ? `${currentPath}/${file.name}` : file.name;
        
        const res = await fetch(`/api/github/repo/${selectedRepo}/contents/${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Upload ${file.name} via Dashboard`,
            content: base64Content
          }),
          credentials: 'include'
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Upload failed');
        }

        setUploadStatus({ type: 'success', message: `Successfully uploaded ${file.name}` });
        fetchRepoContents(selectedRepo, currentPath);
      };
      reader.readAsDataURL(file);
    } catch (err: any) {
      setUploadStatus({ type: 'error', message: err.message || 'Failed to upload file' });
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const navigateToFolder = (path: string) => {
    if (selectedRepo) {
      fetchRepoContents(selectedRepo, path);
    }
  };

  const goBack = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    navigateToFolder(parts.join('/'));
  };

  const filteredRepos = repos.filter(repo => 
    repo.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleTargetRepo = (e: FormEvent) => {
    e.preventDefault();
    if (targetRepoInput.includes('/')) {
      fetchRepoContents(targetRepoInput);
    } else if (user) {
      fetchRepoContents(`${user.login}/${targetRepoInput}`);
    }
  };

  const runDiagnostics = async () => {
    setShowDiagnostics(true);
    setDiagnosticInfo({ status: 'running' });
    try {
      const res = await fetch('/api/auth/status', { credentials: 'include' });
      const data = await res.json();
      setDiagnosticInfo({
        status: 'complete',
        isAuthenticated: data.isAuthenticated,
        cookiesEnabled: navigator.cookieEnabled,
        origin: window.location.origin,
        userAgent: navigator.userAgent
      });
    } catch (err: any) {
      setDiagnosticInfo({ status: 'error', message: err.message });
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0d1117] text-[#c9d1d9] font-sans selection:bg-blue-500/30">
      {/* Navigation */}
      <nav className="border-b border-[#30363d] bg-[#161b22] sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-[#30363d] rounded-lg">
                <Github className="w-6 h-6 text-white" />
              </div>
              <span className="font-semibold text-lg tracking-tight hidden sm:block">GitHub Dashboard</span>
            </div>

            {isAuthenticated && user && (
              <div className="flex items-center gap-4">
                <button
                  onClick={fetchData}
                  disabled={loading}
                  className="p-2 hover:bg-[#30363d] rounded-lg transition-colors disabled:opacity-50"
                  title="Refresh data"
                >
                  <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <div className="h-6 w-px bg-[#30363d]" />
                <div className="flex items-center gap-3">
                  <img
                    src={user.avatar_url}
                    alt={user.login}
                    className="w-8 h-8 rounded-full ring-1 ring-[#30363d]"
                    referrerPolicy="no-referrer"
                  />
                  <button
                    onClick={handleLogout}
                    className="p-2 hover:bg-red-500/10 hover:text-red-400 rounded-lg transition-colors"
                    title="Logout"
                  >
                    <LogOut className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!isAuthenticated ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-20 text-center"
          >
            <div className="w-20 h-20 bg-[#30363d] rounded-3xl flex items-center justify-center mb-6 shadow-2xl shadow-blue-500/10">
              <Github className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-white mb-4 tracking-tight">Connect your GitHub</h1>
            <p className="text-[#8b949e] max-w-md mb-8 text-lg">
              Explore your repositories, track stars, and manage your profile in a beautiful, modern dashboard.
            </p>
            <button
              onClick={handleConnect}
              className="flex items-center gap-3 bg-white text-black px-8 py-4 rounded-xl font-semibold hover:bg-[#f0f6fc] transition-all active:scale-95 shadow-lg shadow-white/5"
            >
              <Github className="w-5 h-5" />
              Connect with GitHub
            </button>
            <p className="mt-8 text-xs text-[#8b949e] uppercase tracking-widest font-medium">
              Secure OAuth Integration
            </p>
          </motion.div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* Sidebar / Profile */}
            <div className="lg:col-span-4 space-y-6">
              {user && (
                <motion.div
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6 overflow-hidden relative"
                >
                  <div className="absolute top-0 left-0 w-full h-24 bg-gradient-to-r from-blue-600/20 to-purple-600/20" />
                  <div className="relative pt-8">
                    <img
                      src={user.avatar_url}
                      alt={user.login}
                      className="w-24 h-24 rounded-2xl border-4 border-[#161b22] shadow-xl mb-4"
                      referrerPolicy="no-referrer"
                    />
                    <h2 className="text-2xl font-bold text-white">{user.name || user.login}</h2>
                    <p className="text-[#8b949e] mb-4">@{user.login}</p>
                    <p className="text-sm text-[#c9d1d9] mb-6 leading-relaxed">{user.bio}</p>

                    <div className="grid grid-cols-3 gap-4 py-4 border-y border-[#30363d]">
                      <div className="text-center">
                        <p className="text-white font-bold">{user.public_repos}</p>
                        <p className="text-[10px] uppercase tracking-wider text-[#8b949e]">Repos</p>
                      </div>
                      <div className="text-center border-x border-[#30363d]">
                        <p className="text-white font-bold">{user.followers}</p>
                        <p className="text-[10px] uppercase tracking-wider text-[#8b949e]">Followers</p>
                      </div>
                      <div className="text-center">
                        <p className="text-white font-bold">{user.following}</p>
                        <p className="text-[10px] uppercase tracking-wider text-[#8b949e]">Following</p>
                      </div>
                    </div>

                    <a
                      href={user.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-6 flex items-center justify-center gap-2 w-full py-3 bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] rounded-xl transition-colors text-sm font-medium"
                    >
                      View on GitHub <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </motion.div>
              )}

              <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8b949e] mb-4 flex items-center gap-2">
                  <Book className="w-4 h-4" /> Target Repository
                </h3>
                <form onSubmit={handleTargetRepo} className="space-y-3">
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="owner/repo or repo-name"
                      value={targetRepoInput}
                      onChange={(e) => setTargetRepoInput(e.target.value)}
                      className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all"
                    />
                  </div>
                  <button
                    type="submit"
                    className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-blue-500/10"
                  >
                    Explore Repository
                  </button>
                </form>
              </div>

              <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-6">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-[#8b949e] mb-4 flex items-center gap-2">
                  <Layout className="w-4 h-4" /> Quick Links
                </h3>
                <div className="space-y-2">
                  {['Repositories', 'Projects', 'Packages', 'Stars'].map((item) => (
                    <button
                      key={item}
                      className="w-full text-left px-4 py-3 rounded-xl hover:bg-[#30363d] transition-colors text-sm font-medium flex items-center justify-between group"
                    >
                      {item}
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity">→</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Main Content / Repos */}
            <div className="lg:col-span-8 space-y-6">
              {selectedRepo ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-[#161b22] border border-[#30363d] rounded-2xl overflow-hidden"
                >
                  <div className="p-6 border-b border-[#30363d] flex items-center justify-between bg-[#1c2128]">
                    <div className="flex items-center gap-3">
                      <button 
                        onClick={() => setSelectedRepo(null)}
                        className="p-2 hover:bg-[#30363d] rounded-lg transition-colors text-[#8b949e]"
                      >
                        ←
                      </button>
                      <div>
                        <h2 className="text-xl font-bold text-white">{selectedRepo}</h2>
                        <p className="text-xs text-[#8b949e] flex items-center gap-1">
                          <Book className="w-3 h-3" /> /{currentPath}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium cursor-pointer transition-colors shadow-lg shadow-blue-500/20">
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        Upload File
                        <input type="file" className="hidden" onChange={handleFileUpload} />
                      </label>
                    </div>
                  </div>

                  {uploadStatus && (
                    <div className={`px-6 py-3 text-sm ${uploadStatus.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'} border-b border-[#30363d]`}>
                      {uploadStatus.message}
                    </div>
                  )}

                  <div className="p-2">
                    {isRepoLoading ? (
                      <div className="p-8 text-center text-[#8b949e]">
                        <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-4" />
                        Loading contents...
                      </div>
                    ) : (
                      <div className="divide-y divide-[#30363d]">
                        {currentPath && (
                          <button
                            onClick={goBack}
                            className="w-full flex items-center gap-3 p-4 hover:bg-[#30363d] transition-colors text-sm text-[#8b949e]"
                          >
                            <Layout className="w-4 h-4" /> ..
                          </button>
                        )}
                        {repoContents.map((item) => (
                          <div
                            key={item.path}
                            className="flex items-center justify-between p-4 hover:bg-[#30363d] transition-colors group"
                          >
                            <div className="flex items-center gap-3 flex-1">
                              {item.type === 'dir' ? (
                                <Layout className="w-4 h-4 text-blue-400" />
                              ) : (
                                <Book className="w-4 h-4 text-[#8b949e]" />
                              )}
                              <button
                                onClick={() => item.type === 'dir' ? navigateToFolder(item.path) : null}
                                className={`text-sm font-medium ${item.type === 'dir' ? 'text-blue-400 hover:underline' : 'text-[#c9d1d9]'}`}
                              >
                                {item.name}
                              </button>
                            </div>
                            <div className="flex items-center gap-4 text-xs text-[#8b949e]">
                              {item.type === 'file' && <span>{(item.size / 1024).toFixed(1)} KB</span>}
                              {item.download_url && (
                                <a
                                  href={item.download_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#21262d] rounded transition-all"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              )}
                            </div>
                          </div>
                        ))}
                        {repoContents.length === 0 && (
                          <div className="p-12 text-center text-[#8b949e]">
                            This folder is empty.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : (
                <>
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-xl font-bold text-white flex items-center gap-2">
                      <Book className="w-5 h-5 text-blue-500" /> Recent Repositories
                    </h2>
                    <div className="relative">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#8b949e]" />
                      <input
                        type="text"
                        placeholder="Search repos..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="bg-[#0d1117] border border-[#30363d] rounded-lg pl-9 pr-4 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 transition-all w-48 sm:w-64"
                      />
                    </div>
                  </div>

                  {loading ? (
                    <div className="space-y-4">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="h-32 bg-[#161b22] border border-[#30363d] rounded-2xl animate-pulse" />
                      ))}
                    </div>
                  ) : error ? (
                    <div className="p-8 bg-red-500/10 border border-red-500/20 rounded-2xl text-center">
                      <p className="text-red-400 mb-6 font-medium">{error}</p>
                      <div className="flex flex-wrap items-center justify-center gap-4">
                        <button
                          onClick={handleConnect}
                          className="px-8 py-3 bg-red-500 text-white rounded-xl hover:bg-red-600 transition-all font-semibold shadow-lg shadow-red-500/20"
                        >
                          Reconnect Account
                        </button>
                        <button
                          onClick={runDiagnostics}
                          className="px-8 py-3 bg-[#30363d] text-white rounded-xl hover:bg-[#3d444d] transition-all font-semibold"
                        >
                          Run Diagnostics
                        </button>
                      </div>

                      {showDiagnostics && diagnosticInfo && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-8 p-6 bg-[#0d1117] border border-[#30363d] rounded-2xl text-left font-mono text-xs"
                        >
                          <h4 className="text-blue-400 mb-4 uppercase tracking-widest text-[10px] font-bold">Diagnostic Results</h4>
                          <pre className="text-[#8b949e] overflow-auto max-h-48">
                            {JSON.stringify(diagnosticInfo, null, 2)}
                          </pre>
                          <p className="mt-4 text-[#8b949e] leading-relaxed">
                            If "isAuthenticated" is false after logging in, your browser might be blocking cross-site cookies. 
                            Try opening the app in a <strong>new tab</strong> or disabling "Block third-party cookies" in your browser settings.
                          </p>
                        </motion.div>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-4">
                      <AnimatePresence mode="popLayout">
                        {filteredRepos.map((repo, index) => (
                          <motion.div
                            key={repo.id}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.05 }}
                            onClick={() => fetchRepoContents(repo.full_name)}
                            className="group bg-[#161b22] border border-[#30363d] rounded-2xl p-6 hover:border-blue-500/50 transition-all hover:shadow-xl hover:shadow-blue-500/5 cursor-pointer"
                          >
                            <div className="flex justify-between items-start mb-2">
                              <div className="flex items-center gap-2">
                                <Book className="w-4 h-4 text-[#8b949e]" />
                                <span className="text-lg font-bold text-blue-400 hover:underline decoration-2 underline-offset-4">
                                  {repo.name}
                                </span>
                                <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#30363d] text-[#8b949e] font-medium uppercase tracking-wider">
                                  Public
                                </span>
                              </div>
                              <div className="flex items-center gap-4 text-sm text-[#8b949e]">
                                <div className="flex items-center gap-1">
                                  <Star className="w-4 h-4" /> {repo.stargazers_count}
                                </div>
                                <div className="flex items-center gap-1">
                                  <GitFork className="w-4 h-4" /> {repo.forks_count}
                                </div>
                              </div>
                            </div>
                            <p className="text-sm text-[#8b949e] mb-4 line-clamp-2 leading-relaxed">
                              {repo.description || 'No description provided.'}
                            </p>
                            <div className="flex items-center gap-4 text-xs font-medium">
                              {repo.language && (
                                <div className="flex items-center gap-1.5">
                                  <span className="w-3 h-3 rounded-full bg-blue-500" />
                                  {repo.language}
                                </div>
                              )}
                              <span className="text-[#8b949e]">
                                Updated {new Date(repo.updated_at).toLocaleDateString()}
                              </span>
                            </div>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Setup Instructions Modal (Overlay if keys missing) */}
      {isConfigured === false && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#161b22] border border-[#30363d] rounded-3xl p-8 max-w-lg w-full shadow-2xl">
            <h2 className="text-2xl font-bold text-white mb-6">Setup Required</h2>
            <p className="text-[#8b949e] mb-6">
              To use this dashboard, you need to configure a GitHub OAuth App.
            </p>
            <div className="space-y-4 mb-8">
              <div className="p-4 bg-[#0d1117] rounded-xl border border-[#30363d]">
                <p className="text-sm font-medium text-white mb-2">1. Create OAuth App</p>
                <p className="text-xs text-[#8b949e]">
                  Go to <a href="https://github.com/settings/developers" target="_blank" className="text-blue-400">GitHub Developer Settings</a> and create a new OAuth App.
                </p>
              </div>
              <div className="p-4 bg-[#0d1117] rounded-xl border border-[#30363d]">
                <p className="text-sm font-medium text-white mb-2">2. Set Callback URL</p>
                <div className="flex items-center gap-2">
                  <code className="text-[10px] flex-1 bg-black p-2 rounded text-emerald-400 break-all">
                    {window.location.origin}/api/auth/github/callback
                  </code>
                  <button 
                    onClick={() => navigator.clipboard.writeText(`${window.location.origin}/api/auth/github/callback`)}
                    className="p-1.5 hover:bg-[#30363d] rounded text-[10px] text-blue-400 font-medium uppercase tracking-wider transition-colors"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div className="p-4 bg-[#0d1117] rounded-xl border border-[#30363d]">
                <p className="text-sm font-medium text-white mb-2">3. Add Secrets</p>
                <p className="text-xs text-[#8b949e]">
                  Add <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> to your AI Studio Secrets.
                </p>
              </div>
            </div>
            <p className="text-xs text-center text-[#8b949e]">
              The app will refresh automatically once configured.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
