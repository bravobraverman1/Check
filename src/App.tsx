import React from 'react';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50 flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full text-center space-y-6">
        <h1 className="text-6xl font-bold tracking-tighter">Clean Slate.</h1>
        <p className="text-zinc-400 text-lg">
          The previous files have been deleted. You can now start building your new application.
        </p>
        <div className="pt-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 border border-zinc-800 text-sm text-zinc-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Ready for your next project
          </div>
        </div>
      </div>
    </div>
  );
};

export default App;
