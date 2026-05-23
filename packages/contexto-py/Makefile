.PHONY: install test fixtures install-local clean

install:
	pip install -e .[test]

test:
	python -m pytest -q

fixtures:
	cd tests/fixtures && node generate_episode_fixture.mjs

install-local:
	python -m contexto_hermes.install

clean:
	rm -rf build dist *.egg-info src/*.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type d -name .pytest_cache -exec rm -rf {} +
